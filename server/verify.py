"""Verifica delle previsioni: archivio delle previsioni (a ogni download) e confronto con le
misure della centralina per i giorni passati (api/verify).

- Previsioni dei modelli: per ogni run, pioggia, temperatura e codice meteo di ogni ora
  futura (tabella forecast_archive). Un run si archivia una volta sola.
- Ensemble: per ogni ora e gruppo la maschera degli scenari con almeno WET_MM (tabella
  ensemble_archive): la probabilità di un intervallo è la quota di scenari bagnati in almeno
  un'ora (OR delle maschere), come windowRainChance() del frontend.
- Misure: dalle letture ogni 10 minuti (station_readings) si ricavano pioggia oraria (dai mm
  cumulati del giorno), temperatura oraria, minima e massima.
- Esiti: per ogni giorno concluso e anticipo (1 o 2 giorni) esiti delle fasce e del giorno per
  modello, probabilità dell'ensemble e misure, calcolati una volta dal job giornaliero
  (store_days()) e salvati in verify_days per VERIFY_KEEP_DAYS (due anni).

Convenzione oraria uguale a Open-Meteo e al frontend: il valore del timestamp T riguarda
l'ora (T-1, T]; il giorno D usa i timestamp D 01:00 … D+1 00:00 (indice 0 … 23).

Cambio dell'ora: Open-Meteo usa un solo scarto da UTC per tutta la risposta, quello del momento
della richiesta (verificato: il 12/10 anche le ore dopo il 25/10 hanno +2 h). Gli orari
archiviati si riportano quindi all'ora locale vera con lo scarto del momento del download
(_real_label()); il giorno con 25 ore somma le due ore 02:00, quello con 23 ha l'ora 02:00
vuota (pioggia 0).
"""

import json
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import config, db, sources

WET_MM = 0.2  # come VERDICT_WET_MM / ENSEMBLE_WET_MM del frontend
NEAR_MS = 8 * 60 * 1000  # una lettura vale per un orario se è entro 8 minuti
LEADS = {1: 'il giorno prima alle 23', 2: 'due giorni prima alle 23'}
# Ora locale del giorno prima (o di due giorni prima) a cui si prende la previsione da verificare:
# l'ultima disponibile a quell'ora.
CUTOFF_HOUR = 23


def _tz():
    return ZoneInfo(config.TIMEZONE)


def _current_hour(utc_offset_s, now_ms=None):
    """Ora piena attuale nel fuso della località, 'YYYY-MM-DDTHH:00'."""
    t = datetime.fromtimestamp((now_ms or db.now_ms()) / 1000, timezone.utc) + timedelta(seconds=utc_offset_s or 0)
    return t.strftime('%Y-%m-%dT%H:00')


# --- Archivio ------------------------------------------------------------------------

def archive_forecast(conn, fc, runs, issued_at):
    """Archivia le ore future delle previsioni appena scaricate; un modello solo se il suo
    run non è già in archivio. Restituisce il numero di righe aggiunte."""
    now_hour = _current_hour(fc.get('utcOffset'), issued_at)
    times = fc['hourly']['time']
    added = 0
    for m in sources.ALL_MODELS:
        key = m['key']
        run_init = (runs.get(key) or {}).get('init') or issued_at // 1000
        if conn.execute('SELECT 1 FROM forecast_archive WHERE model = ? AND run_init = ? LIMIT 1', (key, run_init)).fetchone():
            continue
        h = fc['hourly']['models'].get(key)
        if not h or not h.get('temperature_2m'):
            continue
        rows = [
            (key, run_init, issued_at, t, h['precipitation'][i], h['temperature_2m'][i], h['weather_code'][i])
            for i, t in enumerate(times)
            if t > now_hour and i < len(h['temperature_2m']) and h['temperature_2m'][i] is not None
        ]
        conn.executemany('INSERT OR IGNORE INTO forecast_archive VALUES (?, ?, ?, ?, ?, ?, ?)', rows)
        added += len(rows)
    conn.commit()
    return added


def coarse_block(members, times, i, utc_offset):
    """Indice d'inizio del blocco di 3 ore che contiene l'ora i se lì l'ensemble ha dati ogni
    3 ore (ECMWF ENS sempre, ICON-EU-EPS oltre le ~48 ore), altrimenti None. Open-Meteo divide
    la pioggia delle 3 ore in parti uguali: tutti gli scenari hanno lo stesso valore nelle tre
    ore. I blocchi finiscono alle ore UTC multiple di 3 (timestamp UTC 01, 02, 03 = 00–03).
    Come blockStart() in js/app.js."""
    utc_h = (int(times[i][11:13]) - (utc_offset or 0) // 3600) % 24
    start = i - (utc_h - 1) % 3
    if start < 0 or start + 2 >= len(times):
        return None
    for s in members:
        a = s[start:start + 3]
        if len(a) < 3 or a[0] is None or a[0] != a[1] or a[1] != a[2]:
            return None
    return start


def ensemble_masks(members, i, times=None, utc_offset=0):
    """(maschera degli scenari con almeno WET_MM all'indice i, scenari con il dato). Con dati
    ogni 3 ore (`times` dato) conta il totale del blocco: con la pioggia divisa in tre parti
    uguali servirebbero 0,6 mm per superare la soglia in un'ora."""
    start = coarse_block(members, times, i, utc_offset) if times else None
    mask = n = 0
    for b, s in enumerate(members):
        v = s[i] if i < len(s) else None
        if v is None:
            continue
        n += 1
        if start is not None:
            v = sum(s[start:start + 3])
        if v >= WET_MM - 1e-9:
            mask |= 1 << b
    return mask, n


def archive_ensemble(conn, ens, utc_offset, issued_at):
    now_hour = _current_hour(utc_offset, issued_at)
    rows = []
    for i, t in enumerate(ens['time']):
        if t <= now_hour:
            continue
        for g in ens['groups']:
            mask, n = ensemble_masks(g['members'], i, ens['time'], utc_offset)
            if n:
                rows.append((issued_at, t, g['model'], mask, n))
    conn.executemany('INSERT OR IGNORE INTO ensemble_archive VALUES (?, ?, ?, ?, ?)', rows)
    conn.commit()
    return len(rows)


def thin_ensemble_archive(conn, now_ms=None):
    """Toglie i download dell'ensemble che la verifica non userà mai. ensemble_day() prende
    l'ultimo download prima delle CUTOFF_HOUR (23) del giorno prima o di due giorni prima: per
    ogni giorno passato basta l'ultimo download prima delle 23 (quelli dalle 23 in poi contano
    per il giorno dopo). Degli 8 al giorno ne resta 1. Restituisce il numero di download tolti."""
    tz = _tz()
    today = datetime.fromtimestamp((now_ms or db.now_ms()) / 1000, tz).date()
    last = {}
    for (t,) in conn.execute('SELECT DISTINCT issued_at FROM ensemble_archive ORDER BY issued_at'):
        local = datetime.fromtimestamp(t / 1000, tz)
        d = local.date() + timedelta(days=1 if local.hour >= CUTOFF_HOUR else 0)
        if d < today:
            last.setdefault(d, []).append(t)
    drop = [t for ts in last.values() for t in ts[:-1]]
    conn.executemany('DELETE FROM ensemble_archive WHERE issued_at = ?', [(t,) for t in drop])
    conn.commit()
    return len(drop)


# --- Misure --------------------------------------------------------------------------

def _day_targets(day):
    """Timestamp del giorno: D 01:00 … D 23:00, D+1 00:00."""
    d = datetime.strptime(day, '%Y-%m-%d')
    return [(d + timedelta(hours=h)).strftime('%Y-%m-%dT%H:00') for h in range(1, 25)]


def _offset_at(ms):
    """Scarto da UTC (secondi) del fuso della località all'istante `ms`: quello che Open-Meteo
    ha applicato alla risposta scaricata in quel momento."""
    return int(datetime.fromtimestamp(ms / 1000, _tz()).utcoffset().total_seconds())


def _real_label(label, offset_s):
    """Orario 'YYYY-MM-DDTHH:00' con scarto fisso `offset_s` → stesso istante nell'ora locale vera."""
    t = datetime.strptime(label, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone(timedelta(seconds=offset_s)))
    return t.astimezone(_tz()).strftime('%Y-%m-%dT%H:00')


def _shift_label(label, hours):
    t = datetime.strptime(label, '%Y-%m-%dT%H:%M') + timedelta(hours=hours)
    return t.strftime('%Y-%m-%dT%H:00')


def _day_bounds(day):
    """(inizio, fine) del giorno locale in ms: 23, 24 o 25 ore con il cambio dell'ora."""
    tz = _tz()
    d = datetime.strptime(day, '%Y-%m-%d').date()
    start = datetime(d.year, d.month, d.day, tzinfo=tz)
    nxt = d + timedelta(days=1)
    end = datetime(nxt.year, nxt.month, nxt.day, tzinfo=tz)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _existing_labels(day):
    """Orari (fine di ogni ora reale) del giorno nell'ora locale: senza l'ora saltata a marzo."""
    start_ms, end_ms = _day_bounds(day)
    tz = _tz()
    return {datetime.fromtimestamp(t / 1000, tz).strftime('%Y-%m-%dT%H:00')
            for t in range(start_ms + 3600000, end_ms + 1, 3600000)}


def _station_day(r):
    return datetime.fromtimestamp(r['time'] / 1000, STATION_DAY_TZ).date() if 'time' in r else None


def rain_step(a, b):
    """mm caduti tra due letture consecutive dai mm cumulati della centralina. Il totale
    "di oggi" della centralina NON riparte a mezzanotte (riparte a mezzanotte dell'ora solare,
    cioè alle 01:00 con l'ora legale): un calo forte è l'azzeramento e i mm della nuova
    lettura sono pioggia caduta dopo; un calo piccolo è una correzione e non conta."""
    va, vb = a.get('rainToday'), b.get('rainToday')
    if va is None or vb is None:
        return 0.0
    if vb >= va:
        return vb - va
    # Tra le due letture la centralina ha cambiato giorno (mezzanotte dell'ora solare): è
    # l'azzeramento anche se il calo è piccolo (es. 1,0 → 0,6 mm con pioggia subito dopo).
    da, db_ = _station_day(a), _station_day(b)
    if da is not None and db_ is not None and da != db_:
        return vb
    return vb if vb < va / 2 else 0.0


def _hhmm(ms, tz):
    return datetime.fromtimestamp(ms / 1000, tz).strftime('%H:%M')


# La centralina tiene i valori del giorno (mm, minima, massima, raffica…) sull'ora solare:
# ripartono a mezzanotte di UTC+1, cioè alle 01:00 con l'ora legale.
STATION_DAY_TZ = timezone(timedelta(hours=1))


def station_day_ok(r, tz):
    """True se i valori del giorno della lettura sono già quelli del giorno locale."""
    t = r['time'] / 1000
    return datetime.fromtimestamp(t, STATION_DAY_TZ).date() == datetime.fromtimestamp(t, tz).date()


def _extreme(readings, sample, key, pick, tz):
    """Minima o massima del giorno: la più estrema tra le letture ogni 10 minuti (campo
    `sample`) e il valore della centralina (`key`, misurato in continuo) dell'ultima lettura
    in cui è già del giorno locale (prima del suo azzeramento è ancora quello di ieri)."""
    best = None
    for r in readings:
        v = r.get(sample) if sample else None
        if v is not None and (best is None or (pick(v, best[0]) == v and v != best[0])):
            best = (v, _hhmm(r['time'], tz))
    for r in reversed(readings):
        if not station_day_ok(r, tz):
            break
        v = r.get(key)
        if v is None:
            continue
        if best is None or pick(v, best[0]) == v:
            best = (v, r.get(key + 'Time'))
        break
    return best or (None, None)


# Valori del giorno della centralina: (campo, campo campionato ogni 10 minuti, min/max)
DAY_EXTREMES = [('tMin', 'temperature', min), ('tMax', 'temperature', max),
                ('humidityMin', 'humidity', min), ('humidityMax', 'humidity', max),
                ('pressureMin', 'pressure', min), ('pressureMax', 'pressure', max),
                ('windMax', None, max), ('radiationMax', 'radiation', max)]


def local_day(readings, start_ms, tz):
    """Valori "di oggi" da mezzanotte locale fino all'ultima lettura, da `readings` (in ordine,
    da poco prima di mezzanotte): pioggia dalla somma dei passi (azzeramento della centralina
    compreso) e minime/massime come _extreme(). `rain` = mm cumulati di ogni lettura del
    giorno (None per quelle precedenti), utili per il registro della pioggia in corso."""
    near = [k for k, r in enumerate(readings) if abs(r['time'] - start_ms) <= NEAR_MS]
    day = [k for k, r in enumerate(readings) if r['time'] >= start_ms]
    if not day:
        return None
    base = min(near, key=lambda k: abs(readings[k]['time'] - start_ms)) if near else day[0]
    cum, rain = 0.0, [None] * len(readings)
    for k in range(base, len(readings)):
        if k > base:
            cum += rain_step(readings[k - 1], readings[k])
        rain[k] = round(cum, 1)
    same = [readings[k] for k in day]
    out = {'rainToday': rain[-1], 'fromMidnight': bool(near)}
    for key, sample, pick in DAY_EXTREMES:
        out[key], out[key + 'Time'] = _extreme(same, sample, key, pick, tz)
    return out, rain


def observed_day(conn, day):
    """Misure del giorno dalle letture della centralina: pioggia e temperatura orarie (24
    valori, None dove mancano letture), totale, minima e massima. None se nessuna lettura.
    Le ore sono quelle reali del giorno (23, 24 o 25 con il cambio dell'ora), riportate ai 24
    orari locali: le due ore 02:00 di ottobre si sommano, l'ora 02:00 di marzo vale 0."""
    tz = _tz()
    start_ms, end_ms = _day_bounds(day)
    rows = conn.execute('SELECT data FROM station_readings WHERE time >= ? AND time < ? ORDER BY time',
                        (start_ms - NEAR_MS, end_ms + NEAR_MS)).fetchall()
    readings = [json.loads(r['data']) for r in rows]
    same_day = [r for r in readings if start_ms <= r['time'] < end_ms]
    if not same_day:
        return None

    def closest(t_ms):
        """Indice della lettura più vicina all'istante (entro NEAR_MS), anche del giorno prima
        o dopo: serve come confine delle ore."""
        k = min(range(len(readings)), key=lambda j: abs(readings[j]['time'] - t_ms))
        return k if abs(readings[k]['time'] - t_ms) <= NEAR_MS else None

    def between(i, j):
        """mm caduti tra la lettura i e la lettura j (somma dei passi, azzeramenti compresi)."""
        return sum(rain_step(readings[k - 1], readings[k]) for k in range(i + 1, j + 1))

    # Confini delle ore reali: la lettura più vicina a ogni ora piena, da mezzanotte a
    # mezzanotte. Non si assume che a mezzanotte il totale della centralina riparta da zero.
    hours = (end_ms - start_ms) // 3600000
    edge = [closest(start_ms + k * 3600000) for k in range(hours + 1)]
    targets = _day_targets(day)
    real = _existing_labels(day)
    rain = [None if t in real else 0.0 for t in targets]
    temp = [None] * 24
    seen = [False] * 24
    for k in range(hours):
        label = datetime.fromtimestamp((start_ms + (k + 1) * 3600000) / 1000, tz).strftime('%Y-%m-%dT%H:00')
        h = targets.index(label)
        v = between(edge[k], edge[k + 1]) if edge[k] is not None and edge[k + 1] is not None else None
        # ora 02:00 doppia (ottobre): somma; basta una parte mancante per non avere il dato
        rain[h] = v if not seen[h] else (None if v is None or rain[h] is None else rain[h] + v)
        seen[h] = True
        if edge[k + 1] is not None:
            temp[h] = readings[edge[k + 1]].get('temperature')
    rain = [round(v, 1) if v is not None else None for v in rain]

    first = edge[0] if edge[0] is not None else readings.index(same_day[0])
    last_i = edge[-1] if edge[-1] is not None else readings.index(same_day[-1])
    day_done = edge[-1] is not None or same_day[-1]['time'] >= end_ms - 15 * 60 * 1000
    t_min, t_min_time = _extreme(same_day, 'temperature', 'tMin', min, tz)
    t_max, t_max_time = _extreme(same_day, 'temperature', 'tMax', max, tz)
    return {
        'rain': rain,
        'temp': temp,
        # mm del giorno dalle letture; senza la lettura di mezzanotte manca la pioggia
        # caduta prima della prima lettura (il giorno è comunque "incompleto")
        'total': round(between(first, last_i), 1),
        'tMin': t_min, 'tMinTime': t_min_time,
        'tMax': t_max, 'tMaxTime': t_max_time,
        'complete': edge[0] is not None and day_done and sum(v is not None for v in rain) >= 20,
        'lastReading': same_day[-1]['time'],
    }


# --- Previsioni del giorno ---------------------------------------------------------

def _cutoff_ms(day, lead):
    """Ultimo istante utile per la previsione: le CUTOFF_HOUR (23) locali di `lead` giorni prima."""
    d = datetime.strptime(day, '%Y-%m-%d').date() - timedelta(days=lead)
    return int(datetime(d.year, d.month, d.day, CUTOFF_HOUR, tzinfo=_tz()).timestamp() * 1000)


def _archived_range(day):
    """Orari da chiedere all'archivio per il giorno: un'ora in più per parte, perché gli orari
    archiviati possono avere lo scarto da UTC dell'altro lato del cambio dell'ora."""
    targets = _day_targets(day)
    return _shift_label(targets[0], -2), _shift_label(targets[-1], 2)


def forecast_day(conn, day, lead):
    """Per ogni modello l'ultima previsione disponibile prima del limite (il giorno prima o
    due giorni prima, alle 23), con pioggia, temperatura e codice per le 24 ore del giorno (ore locali
    vere: vedi _real_label())."""
    cutoff = _cutoff_ms(day, lead)
    targets = _day_targets(day)
    index = {t: k for k, t in enumerate(targets)}
    missing = [t not in _existing_labels(day) for t in targets]
    lo, hi = _archived_range(day)
    out = {}
    for m in sources.ALL_MODELS:
        key = m['key']
        row = conn.execute(
            'SELECT run_init, issued_at FROM forecast_archive WHERE model = ? AND target = ? AND issued_at < ? '
            'ORDER BY issued_at DESC LIMIT 1', (key, f'{day}T12:00', cutoff)).fetchone()
        if not row:
            out[key] = None
            continue
        rain, temp, code = [None] * 24, [None] * 24, [None] * 24
        seen = [False] * 24
        for r in conn.execute(
                'SELECT target, issued_at, precip, temp, code FROM forecast_archive '
                'WHERE model = ? AND run_init = ? AND target >= ? AND target <= ? ORDER BY target',
                (key, row['run_init'], lo, hi)):
            h = index.get(_real_label(r['target'], _offset_at(r['issued_at'])))
            if h is None:
                continue
            p = r['precip']
            # ora 02:00 doppia (ottobre): pioggia sommata, temperatura dell'ultima, codice peggiore
            rain[h] = p if not seen[h] else (None if p is None or rain[h] is None else rain[h] + p)
            temp[h] = r['temp']
            code[h] = r['code'] if not seen[h] or code[h] is None or (r['code'] or 0) > code[h] else code[h]
            seen[h] = True
        for h in range(24):
            if missing[h] and rain[h] is None:
                rain[h] = 0.0  # ora saltata (marzo): nessuna pioggia
        out[key] = {
            'issuedAt': row['issued_at'], 'runInit': row['run_init'],
            'rain': [round(v, 2) if v is not None else None for v in rain], 'temp': temp, 'code': code,
        }
    return out


def ensemble_day(conn, day, lead):
    """Ultimo ensemble disponibile prima del limite: per gruppo maschere e scenari per ora
    (ore locali vere: vedi _real_label())."""
    cutoff = _cutoff_ms(day, lead)
    targets = _day_targets(day)
    index = {t: k for k, t in enumerate(targets)}
    row = conn.execute(
        'SELECT issued_at FROM ensemble_archive WHERE target = ? AND issued_at < ? ORDER BY issued_at DESC LIMIT 1',
        (f'{day}T12:00', cutoff)).fetchone()
    if not row:
        return None
    offset = _offset_at(row['issued_at'])
    lo, hi = _archived_range(day)
    groups = {}
    for r in conn.execute('SELECT target, grp, mask, n FROM ensemble_archive WHERE issued_at = ? AND target >= ? AND target <= ?',
                          (row['issued_at'], lo, hi)):
        h = index.get(_real_label(r['target'], offset))
        if h is None:
            continue
        g = groups.setdefault(r['grp'], {'model': r['grp'], 'masks': [None] * 24, 'n': [0] * 24})
        # ora 02:00 doppia (ottobre): bagnato in almeno una delle due
        g['masks'][h] = r['mask'] | (g['masks'][h] or 0)
        g['n'][h] = max(g['n'][h], r['n'])
    # ora saltata (marzo): nessuno scenario bagnato
    real = _existing_labels(day)
    for t in targets:
        if t not in real:
            for g in groups.values():
                h = index[t]
                g['masks'][h], g['n'][h] = 0, max(g['n']) or 0
    order = [m['name'] for m in sources.ENSEMBLE_MODELS]
    return {'issuedAt': row['issued_at'], 'groups': sorted(groups.values(), key=lambda g: order.index(g['model']) if g['model'] in order else 99)}


# --- Esiti ------------------------------------------------------------------------------
# Calcolati qui (non più nel browser) e salvati in verify_days per i giorni conclusi: un
# cambio delle regole vale per i giorni nuovi; per rielaborare lo storico ancora coperto dagli
# archivi: python3 -m server.jobs verify --force.

SLOT_STARTS = (0, 6, 12, 18)  # fasce di 6 ore, come SLOTS del frontend
# Quantità molto diversa (solo se pioggia prevista e caduta): una almeno QTY_RATIO volte
# l'altra con scarto di almeno QTY_MM, come il criterio di concordanza sulla quantità.
QTY_RATIO = 2
QTY_MM = 2.0
_SLOT_HOURS = [list(range(a, a + 6)) for a in SLOT_STARTS]
_DAY_HOURS = list(range(24))


def _round(v, scale=10):
    """Arrotondamento come Math.round del frontend (la metà verso l'alto, non "al pari")."""
    return math.floor(v * scale + 0.5) / scale


def _total(arr, hours):
    """Somma delle ore (un decimale), None se ne manca anche una."""
    if not arr:
        return None
    s = 0.0
    for h in hours:
        if arr[h] is None:
            return None
        s += arr[h]
    return _round(s)


def outcome(fc, obs):
    """'hit' / 'ok' / 'false' (falso allarme) / 'miss' (pioggia non prevista), None senza dati."""
    if fc is None or obs is None:
        return None
    f, o = fc >= WET_MM - 1e-9, obs >= WET_MM - 1e-9
    return ('hit' if o else 'false') if f else ('miss' if o else 'ok')


def qty_off(fc, obs):
    """'more' = caduta molta più pioggia del previsto, 'less' = molta meno, None altrimenti."""
    if outcome(fc, obs) != 'hit' or abs(fc - obs) < QTY_MM - 1e-9:
        return None
    if obs >= QTY_RATIO * fc:
        return 'more'
    if fc >= QTY_RATIO * obs:
        return 'less'
    return None


def chance(ens, hours):
    """Probabilità (%) di almeno WET_MM in almeno un'ora: quota di scenari bagnati (OR delle
    maschere), media dei gruppi che coprono tutte le ore; come windowRainChance() dell'app."""
    if not ens:
        return None
    parts = []
    for g in ens['groups']:
        if any(not g['n'][h] for h in hours):
            continue
        mask = 0
        for h in hours:
            mask |= g['masks'][h] or 0
        parts.append(bin(mask).count('1') / min(g['n'][h] for h in hours))
    return int(_round(100 * sum(parts) / len(parts), 1)) if parts else None


def _judge(fc, obs, judge=True):
    """Cella della verifica: previsto, esito e quantità (esito solo se `judge`)."""
    return {'fc': fc, 'res': outcome(fc, obs) if judge else None, 'qty': qty_off(fc, obs) if judge else None}


def day_result(conn, day, lead, obs=None):
    """Esiti del giorno per la previsione di `lead` giorni prima: per ogni fascia e per il giorno
    intero pioggia misurata, prevista da ogni modello con l'esito, probabilità dell'ensemble;
    massima e minima previste e misurate. None se non ci sono misure. Il totale del giorno si
    giudica solo a giornata completa."""
    obs = obs or observed_day(conn, day)
    if not obs:
        return None
    o_slots = [_total(obs['rain'], hs) for hs in _SLOT_HOURS]
    models = {}
    for key, f in forecast_day(conn, day, lead).items():
        if not f:
            models[key] = None
            continue
        temps = [t for t in f['temp'] if t is not None]
        models[key] = {
            'runInit': f['runInit'], 'issuedAt': f['issuedAt'],
            'slots': [_judge(_total(f['rain'], hs), o) for hs, o in zip(_SLOT_HOURS, o_slots)],
            'day': _judge(_total(f['rain'], _DAY_HOURS), obs['total'], obs['complete']),
            'tMax': max(temps) if temps else None, 'tMin': min(temps) if temps else None,
        }
    ens = ensemble_day(conn, day, lead)
    return {
        'day': day,
        'observed': {k: obs[k] for k in ('total', 'tMin', 'tMinTime', 'tMax', 'tMaxTime', 'complete')} | {'slots': o_slots},
        'models': models,
        'ensemble': {'issuedAt': ens['issuedAt'], 'slots': [chance(ens, hs) for hs in _SLOT_HOURS],
                     'day': chance(ens, _DAY_HOURS)} if ens else None,
    }


def _final(day, obs, today):
    """Un giorno è concluso (esiti da salvare) se è passato e le misure sono complete, oppure se
    è di almeno due giorni fa (non arriverà più niente)."""
    d = datetime.strptime(day, '%Y-%m-%d').date()
    return d < today and (obs['complete'] or d <= today - timedelta(days=2))


def store_days(conn, force=False, now_ms=None):
    """Salva in verify_days gli esiti dei giorni conclusi che mancano (con `force` li rielabora
    tutti, ma solo dove ci sono ancora le misure: gli esiti più vecchi degli archivi restano).
    Dal giorno della prima lettura della centralina, al massimo VERIFY_KEEP_DAYS. Restituisce
    il numero di giorni salvati."""
    tz = _tz()
    now_ms = now_ms or db.now_ms()
    today = datetime.fromtimestamp(now_ms / 1000, tz).date()
    first = conn.execute('SELECT MIN(time) FROM station_readings').fetchone()[0]
    if first is None:
        return 0
    start = max(datetime.fromtimestamp(first / 1000, tz).date(), today - timedelta(days=config.VERIFY_KEEP_DAYS))
    have = {(r['day'], r['lead']) for r in conn.execute('SELECT day, lead FROM verify_days')}
    saved = 0
    d = start
    while d < today:
        day = d.isoformat()
        d += timedelta(days=1)
        leads = [lead for lead in LEADS if force or (day, lead) not in have]
        if not leads:
            continue
        obs = observed_day(conn, day)
        if not obs or not _final(day, obs, today):
            continue
        for lead in leads:
            data = day_result(conn, day, lead, obs)
            conn.execute('INSERT OR REPLACE INTO verify_days (day, lead, computed_at, data) VALUES (?, ?, ?, ?)',
                         (day, lead, now_ms, json.dumps(data, separators=(',', ':'))))
            saved += 1
    conn.commit()
    return saved


def compose_verify(conn, days=30, lead=1):
    """Giorni dal più recente (oggi, parziale) al più vecchio, solo quelli con misure: esiti
    salvati in verify_days, calcolati al momento solo per i giorni non ancora salvati (oggi,
    ieri prima del job giornaliero). In sola lettura: a salvare è il job (store_days())."""
    days = max(1, min(int(days), config.VERIFY_KEEP_DAYS))
    lead = lead if lead in LEADS else 1
    today = datetime.now(_tz()).date()
    first = (today - timedelta(days=days - 1)).isoformat()
    stored = {r['day']: json.loads(r['data']) for r in conn.execute(
        'SELECT day, data FROM verify_days WHERE lead = ? AND day >= ?', (lead, first))}
    out = []
    for k in range(days):
        day = (today - timedelta(days=k)).isoformat()
        d = stored.get(day) or day_result(conn, day, lead)
        if d:
            out.append({**d, 'today': k == 0})
    return {'lead': lead, 'leadLabel': LEADS[lead], 'wetMm': WET_MM, 'days': out}
