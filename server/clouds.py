"""Nuvolosità osservata a Faenza, per correggere le previsioni di oggi (non si mostra da sola).

Due fonti, senza chiave:
- di giorno la radiazione solare misurata dalla centralina (già salvata a ogni lettura):
  rispetto a quella attesa a cielo sereno dà la quota di sole che passa, quindi le nuvole di
  ogni quota sopra Faenza. Si usa con il sole alto almeno SUN_MIN_ALT gradi;
- altrimenti (notte, sole basso) i bollettini METAR degli aeroporti di Forlì (LIPK, ~15 km,
  orario, può mancare di notte) e Bologna (LIPE, ~45 km, ogni 30 minuti). Riportano solo le
  nubi basse (sotto ~1500 m) e i cumulonembi: il valore è un minimo ("almeno"), utile per
  nubi basse e nebbia ma non per togliere nuvole alte previste dai modelli.

Il job `clouds` (cron) salva i METAR nella tabella metar; estimate() compone la stima che
api/station manda con la misura della centralina (campo clouds). La correzione delle
previsioni la fa il browser (cloudFix() in js/app.js), come per la temperatura.
"""

import json
import math
import time

from . import db, sources

METAR_URL = 'https://aviationweather.gov/api/data/metar'
# Più vicino prima; un bollettino vale se ha al massimo max_age_s secondi.
METAR_STATIONS = [('LIPK', 'Forlì', 70 * 60), ('LIPE', 'Bologna', 45 * 60)]
# Copertura dei gruppi METAR in percentuale (ottavi: FEW 1–2, SCT 3–4, BKN 5–7, OVC 8;
# VV / OVX = cielo invisibile, di solito nebbia). Senza nubi riportate: 0.
METAR_COVER = {'FEW': 19, 'SCT': 44, 'BKN': 75, 'OVC': 100, 'OVX': 100, 'VV': 100}
METAR_CLEAR = {'CLR', 'SKC', 'NSC', 'NCD', 'CAVOK'}

SUN_MIN_ALT = 15        # gradi: sotto, la radiazione attesa a cielo sereno è poco affidabile
SUN_WINDOW_S = 30 * 60  # media delle letture degli ultimi 30 minuti (una nuvola che passa non basta)
CAL_DAYS = 30           # taratura sulle letture degli ultimi 30 giorni…
CAL_MIN_ALT = 25        # …con il sole alto almeno 25 gradi
CAL_MIN_SAMPLES = 300   # meno letture: niente taratura (fattore 1)
CAL_RANGE = (0.7, 1.3)
CAL_EVERY_S = 3600


def clear_sky(alt_deg):
    """Radiazione globale a cielo sereno in W/m² (modello di Haurwitz) con il sole a alt_deg."""
    s = math.sin(math.radians(alt_deg))
    return 1098 * s * math.exp(-0.059 / s) if s > 0 else 0.0


# Scala tra la quota di sole che passa e la nuvolosità: da K_CLEAR in su sereno, da K_OVERCAST
# in giù coperto, in mezzo lineare. Più robusta della relazione di Kasten e Czeplak invertita,
# che vicino al sereno trasforma pochi punti di radiazione in meno (foschia, taratura del
# sensore) in metà cielo coperto.
K_CLEAR = 0.95
K_OVERCAST = 0.30


def cover_from_k(k):
    """Nuvolosità (0–100) dalla quota di sole che passa k = misurata / cielo sereno."""
    return round(100 * min(1, max(0, (K_CLEAR - k) / (K_CLEAR - K_OVERCAST))))


def _k(reading):
    rad, alt = reading.get('radiation'), reading.get('sunAltitude')
    if rad is None or alt is None or alt < SUN_MIN_ALT:
        return None
    return rad / clear_sky(alt)


_cal = {'at': 0, 'value': 1.0}


def calibration(conn, now_s=None):
    """Fattore di taratura del sensore e del modello di cielo sereno: il 95° percentile di k
    nelle ultime settimane (i momenti più sereni) vale come "cielo sereno". Ricalcolato al
    più una volta all'ora."""
    now_s = now_s or time.time()
    if now_s - _cal['at'] < CAL_EVERY_S:
        return _cal['value']
    since = int((now_s - CAL_DAYS * 86400) * 1000)
    ks = sorted(k for r in db.station_since(conn, since)
                if (r.get('sunAltitude') or 0) >= CAL_MIN_ALT and (k := _k(r)) is not None)
    value = 1.0
    if len(ks) >= CAL_MIN_SAMPLES:
        value = min(max(ks[int(len(ks) * 0.95)], CAL_RANGE[0]), CAL_RANGE[1])
    _cal.update(at=now_s, value=value)
    return value


def parse_metar(item):
    """Un bollettino dell'API di aviationweather.gov (formato JSON) → riga della tabella metar,
    o None se manca l'orario. cover = copertura massima riportata (0–100)."""
    icao, t = item.get('icaoId'), item.get('obsTime')
    if not icao or not t:
        return None
    covers = [METAR_COVER.get((c.get('cover') or '').upper()) for c in item.get('clouds') or []]
    covers = [c for c in covers if c is not None]
    if covers:
        cover = max(covers)
    elif (item.get('cover') or '').upper() in METAR_CLEAR or 'CAVOK' in (item.get('rawOb') or ''):
        cover = 0
    else:
        cover = None  # copertura non riportata
    return {'icao': icao, 'time': int(t) * 1000, 'cover': cover, 'raw': item.get('rawOb') or ''}


def run(conn, force=False):
    """Job `clouds`: scarica i METAR delle ultime 3 ore e salva quelli nuovi."""
    ids = ','.join(s[0] for s in METAR_STATIONS)
    try:
        items = json.loads(sources._get(METAR_URL, {'ids': ids, 'format': 'json', 'hours': 3}) or b'[]')
    except json.JSONDecodeError as err:
        raise sources.SourceError('risposta METAR non valida') from err
    rows = [r for r in map(parse_metar, items if isinstance(items, list) else []) if r]
    new = db.put_metar(conn, rows)
    return f'{len(rows)} bollettini, {new} nuovi'


def estimate(conn, st, now_ms=None):
    """Nuvolosità osservata per api/station, o None se non c'è un dato recente:
    {cover 0–100, kind 'total' | 'min', source 'sun' | 'metar', time ms, ...}.
    kind 'min' = solo nubi basse (METAR): le nuvole sono almeno tante."""
    now_ms = now_ms or db.now_ms()
    if st and now_ms - st['time'] <= SUN_WINDOW_S * 1000:
        recent = [r for r in db.station_since(conn, st['time'] - SUN_WINDOW_S * 1000)]
        ks = [k for r in recent if (k := _k(r)) is not None]
        if ks and _k(st) is not None:
            cal = calibration(conn, now_ms / 1000)
            k = sum(ks) / len(ks) / cal
            return {'cover': cover_from_k(k), 'kind': 'total', 'source': 'sun', 'time': st['time'],
                    'k': round(k, 2), 'sunAltitude': st.get('sunAltitude')}
    for icao, name, max_age in METAR_STATIONS:
        m = db.latest_metar(conn, icao)
        if m and m['cover'] is not None and now_ms - m['time'] <= max_age * 1000:
            return {'cover': m['cover'], 'kind': 'min', 'source': 'metar', 'time': m['time'],
                    'station': name, 'raw': m['raw']}
    return None
