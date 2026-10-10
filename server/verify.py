"""Verifica delle previsioni: archivio delle previsioni (a ogni download) e confronto con le
misure della centralina per i giorni passati (api/verify).

- Previsioni dei modelli: per ogni run, pioggia, temperatura e codice meteo di ogni ora
  futura (tabella forecast_archive). Un run si archivia una volta sola.
- Ensemble: per ogni ora e gruppo la maschera degli scenari con almeno WET_MM (tabella
  ensemble_archive): la probabilità di un intervallo è la quota di scenari bagnati in almeno
  un'ora (OR delle maschere), come windowRainChance() del frontend.
- Misure: dalle letture ogni 10 minuti (station_readings) si ricavano pioggia oraria (dai mm
  cumulati del giorno), temperatura oraria, minima e massima.

Convenzione oraria uguale a Open-Meteo e al frontend: il valore del timestamp T riguarda
l'ora (T-1, T]; il giorno D usa i timestamp D 01:00 … D+1 00:00 (indice 0 … 23).
"""

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import config, db, sources

WET_MM = 0.2  # come BIKE_WET_MM / ENSEMBLE_WET_MM del frontend
NEAR_MS = 8 * 60 * 1000  # una lettura vale per un orario se è entro 8 minuti
LEADS = {1: 'la sera prima', 2: 'due giorni prima'}


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
    for m in sources.MODELS:
        key = m['key']
        run_init = (runs.get(key) or {}).get('init') or issued_at // 1000
        if conn.execute('SELECT 1 FROM forecast_archive WHERE model = ? AND run_init = ? LIMIT 1', (key, run_init)).fetchone():
            continue
        h = fc['hourly']['models'][key]
        rows = [
            (key, run_init, issued_at, t, h['precipitation'][i], h['temperature_2m'][i], h['weather_code'][i])
            for i, t in enumerate(times)
            if t > now_hour and i < len(h['temperature_2m']) and h['temperature_2m'][i] is not None
        ]
        conn.executemany('INSERT OR IGNORE INTO forecast_archive VALUES (?, ?, ?, ?, ?, ?, ?)', rows)
        added += len(rows)
    conn.commit()
    return added


def ensemble_masks(members, i):
    """(maschera degli scenari con almeno WET_MM all'indice i, scenari con il dato)."""
    mask = n = 0
    for b, s in enumerate(members):
        v = s[i] if i < len(s) else None
        if v is None:
            continue
        n += 1
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
            mask, n = ensemble_masks(g['members'], i)
            if n:
                rows.append((issued_at, t, g['model'], mask, n))
    conn.executemany('INSERT OR IGNORE INTO ensemble_archive VALUES (?, ?, ?, ?, ?)', rows)
    conn.commit()
    return len(rows)


# --- Misure --------------------------------------------------------------------------

def _day_targets(day):
    """Timestamp del giorno: D 01:00 … D 23:00, D+1 00:00."""
    d = datetime.strptime(day, '%Y-%m-%d')
    return [(d + timedelta(hours=h)).strftime('%Y-%m-%dT%H:00') for h in range(1, 25)]


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
    valori, None dove mancano letture), totale, minima e massima. None se nessuna lettura."""
    tz = _tz()
    start = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=tz)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int((start + timedelta(days=1)).timestamp() * 1000)
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

    # Confini delle ore: la lettura più vicina a ogni ora piena, da mezzanotte a mezzanotte.
    # Non si assume che a mezzanotte il totale della centralina riparta da zero.
    edge = [closest(start_ms + hh * 3600000) for hh in range(25)]
    rain = [round(between(edge[hh], edge[hh + 1]), 1) if edge[hh] is not None and edge[hh + 1] is not None else None
            for hh in range(24)]
    temp = [readings[edge[hh]].get('temperature') if edge[hh] is not None else None for hh in range(1, 25)]

    first = edge[0] if edge[0] is not None else readings.index(same_day[0])
    last_i = edge[24] if edge[24] is not None else readings.index(same_day[-1])
    day_done = edge[24] is not None or same_day[-1]['time'] >= end_ms - 15 * 60 * 1000
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
    """Ultimo istante utile per la previsione: mezzanotte del giorno meno (lead-1) giorni."""
    start = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=_tz())
    return int((start - timedelta(days=lead - 1)).timestamp() * 1000)


def forecast_day(conn, day, lead):
    """Per ogni modello l'ultima previsione disponibile prima del limite (la sera prima o
    due giorni prima), con pioggia, temperatura e codice per le 24 ore del giorno."""
    cutoff = _cutoff_ms(day, lead)
    targets = _day_targets(day)
    out = {}
    for m in sources.MODELS:
        key = m['key']
        row = conn.execute(
            'SELECT run_init, issued_at FROM forecast_archive WHERE model = ? AND target = ? AND issued_at < ? '
            'ORDER BY issued_at DESC LIMIT 1', (key, f'{day}T12:00', cutoff)).fetchone()
        if not row:
            out[key] = None
            continue
        vals = {r['target']: r for r in conn.execute(
            'SELECT target, precip, temp, code FROM forecast_archive WHERE model = ? AND run_init = ? AND target >= ? AND target <= ?',
            (key, row['run_init'], targets[0], targets[-1]))}
        out[key] = {
            'issuedAt': row['issued_at'], 'runInit': row['run_init'],
            'rain': [vals[t]['precip'] if t in vals else None for t in targets],
            'temp': [vals[t]['temp'] if t in vals else None for t in targets],
            'code': [vals[t]['code'] if t in vals else None for t in targets],
        }
    return out


def ensemble_day(conn, day, lead):
    """Ultimo ensemble disponibile prima del limite: per gruppo maschere e scenari per ora."""
    cutoff = _cutoff_ms(day, lead)
    targets = _day_targets(day)
    row = conn.execute(
        'SELECT issued_at FROM ensemble_archive WHERE target = ? AND issued_at < ? ORDER BY issued_at DESC LIMIT 1',
        (f'{day}T12:00', cutoff)).fetchone()
    if not row:
        return None
    groups = {}
    for r in conn.execute('SELECT target, grp, mask, n FROM ensemble_archive WHERE issued_at = ? AND target >= ? AND target <= ?',
                          (row['issued_at'], targets[0], targets[-1])):
        g = groups.setdefault(r['grp'], {'model': r['grp'], 'masks': [None] * 24, 'n': [0] * 24})
        k = targets.index(r['target'])
        g['masks'][k], g['n'][k] = r['mask'], r['n']
    order = [m['name'] for m in sources.ENSEMBLE_MODELS]
    return {'issuedAt': row['issued_at'], 'groups': sorted(groups.values(), key=lambda g: order.index(g['model']) if g['model'] in order else 99)}


def compose_verify(conn, days=30, lead=1):
    """Giorni dal più recente (oggi, parziale) al più vecchio, solo quelli con misure."""
    days = max(1, min(int(days), 120))
    lead = lead if lead in LEADS else 1
    today = datetime.now(_tz()).date()
    out = []
    for k in range(days):
        day = (today - timedelta(days=k)).isoformat()
        obs = observed_day(conn, day)
        if not obs:
            continue
        out.append({'day': day, 'today': k == 0, 'observed': obs,
                    'models': forecast_day(conn, day, lead), 'ensemble': ensemble_day(conn, day, lead)})
    return {'lead': lead, 'leadLabel': LEADS[lead], 'wetMm': WET_MM, 'days': out}
