"""Livelli dei fiumi Lamone e Marzeno (idrometri ARPAE Emilia-Romagna, portale Allerta Meteo).

Il job (ogni 15 minuti, vedi deploy/crontab) scarica le soglie di allerta di tutte le
stazioni (una richiesta) e la serie degli ultimi ~2,5 giorni delle stazioni in RIVERS (una
richiesta ciascuna), e salva i valori in river_levels: lo storico resta anche oltre i 2,5
giorni dell'API. Il dato arriva con 30–60 minuti di ritardo.

api/rivers restituisce per ogni fiume le stazioni (dalla più a monte) con soglie, ultimo
valore, tendenza nell'ultima ora e serie delle ultime SERIES_H ore.
"""

from . import db, sources

SERIES_H = 48  # ore della serie mostrata nel grafico
TREND_MIN = 60  # minuti su cui si calcola la tendenza


def run(conn, force=False):
    thresholds = sources.fetch_river_thresholds()
    meta, added = {}, 0
    for river in sources.RIVERS:
        for st in river['stations']:
            sid = st['id']
            if sid in thresholds:
                meta[str(sid)] = thresholds[sid]
            series = sources.fetch_river_series(sid)
            cur = conn.executemany('INSERT OR IGNORE INTO river_levels (station, time, value) VALUES (?, ?, ?)',
                                   [(sid, t, v) for t, v in series])
            added += cur.rowcount
    db.put_snapshot(conn, 'rivers', meta)
    conn.commit()
    return f'{added} livelli nuovi'


def level(v, s):
    """0 = sotto la soglia 1, poi 1, 2, 3 = soglia superata."""
    return 3 if v >= s[2] else 2 if v >= s[1] else 1 if v >= s[0] else 0


def compose(conn):
    """{time, fetchedAt, rivers: [{key, name, level, stations: [{id, name, where, s, t, v,
    level, trend (m/h o None), series: [[t, v]…]}]}]} o None se non ci sono dati."""
    snap = db.get_snapshot(conn, 'rivers')
    if not snap:
        return None
    meta = snap['data']
    rivers, latest = [], 0
    for river in sources.RIVERS:
        stations = []
        for st in river['stations']:
            sid = st['id']
            last = conn.execute('SELECT time, value FROM river_levels WHERE station = ? ORDER BY time DESC LIMIT 1', (sid,)).fetchone()
            s = (meta.get(str(sid)) or {}).get('s')
            if not last or not s:
                continue
            t, v = last['time'], last['value']
            latest = max(latest, t)
            rows = conn.execute('SELECT time, value FROM river_levels WHERE station = ? AND time >= ? ORDER BY time',
                                (sid, t - SERIES_H * 3600000)).fetchall()
            ref = conn.execute('SELECT value FROM river_levels WHERE station = ? AND time <= ? ORDER BY time DESC LIMIT 1',
                               (sid, t - TREND_MIN * 60000)).fetchone()
            ref_ok = ref is not None and rows and rows[0]['time'] <= t - TREND_MIN * 60000
            stations.append({
                **st, 's': s, 't': t, 'v': v, 'level': level(v, s),
                'trend': round((v - ref['value']) * 60 / TREND_MIN, 2) if ref_ok else None,
                'series': [[r['time'], r['value']] for r in rows],
            })
        if stations:
            rivers.append({'key': river['key'], 'name': river['name'],
                           'level': max(x['level'] for x in stations), 'stations': stations})
    if not rivers:
        return None
    return {'time': latest, 'fetchedAt': snap['fetched_at'], 'rivers': rivers}
