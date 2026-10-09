"""API JSON per il frontend (dietro nginx, che serve i file statici):

  GET api/forecast  previsioni + ensemble + metadati dei run (forma usata da js/app.js)
  GET api/station   ultima misura della centralina + letture delle ultime 2 ore (rainLog)
  GET api/normals   medie del periodo 1991–2020
  GET api/status    stato dei job (ultimo aggiornamento, errori)
  GET api/verify?days=30&lead=1
                    verifica dei giorni passati: misure della centralina e previsioni
                    disponibili la sera prima (lead=1) o due giorni prima (lead=2)

Le risposte hanno un ETag: il browser rivalida (Cache-Control: no-cache) e riceve 304
finché i dati non cambiano. Le richieste non toccano mai le fonti esterne.

Avvio:  python3 -m server.api                      (solo API, per nginx)
        python3 -m server.api --static             (anche i file del frontend, in locale)
"""

import argparse
import copy
import hashlib
import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

from urllib.parse import parse_qs, urlsplit

from . import config, db, sources, verify

_cache = {}  # chiave → (corpo, etag): JSON già composto delle previsioni
_cache_lock = threading.Lock()


def _local_today(utc_offset_s, now_ms):
    """Data di oggi nel fuso della località (come localNowIso del frontend)."""
    t = datetime.fromtimestamp(now_ms / 1000, timezone.utc) + timedelta(seconds=utc_offset_s or 0)
    return t.strftime('%Y-%m-%d')


def trim_forecast(fc, ens, today):
    """Di ieri si tiene solo l'ultima ora (23:00) per i dati orari, nulla per i giornalieri
    (dopo mezzanotte il grafico parte dall'ora precedente). L'ensemble parte dalla stessa ora."""
    h, d = fc['hourly'], fc['daily']
    first_today = next((i for i, t in enumerate(h['time']) if t >= today), len(h['time']))
    sources.slice_block(h, sources.HOURLY_VARS, sources.COMMON_HOURLY, max(0, first_today - 1))
    first_day = next((i for i, t in enumerate(d['time']) if t >= today), len(d['time']))
    if first_day > 0:
        sources.slice_block(d, sources.DAILY_VARS, sources.COMMON_DAILY, first_day)
    if ens and h['time']:
        try:
            start = ens['time'].index(h['time'][0])
        except ValueError:
            start = 0
        if start:
            ens['time'] = ens['time'][start:]
            for g in ens['groups']:
                g['members'] = [s[start:] for s in g['members']]


def compose_forecast(conn, now_ms):
    """(corpo JSON, etag) delle previsioni, o None se non ci sono ancora."""
    times = tuple(db.snapshot_time(conn, n) for n in ('forecast', 'ensemble', 'runs'))
    if not times[0]:
        return None
    fc = db.get_snapshot(conn, 'forecast')
    today = _local_today(fc['data'].get('utcOffset'), now_ms)
    ens_fresh = times[1] and now_ms - times[1] <= config.ENSEMBLE_MAX_AGE_S * 1000
    key = (times, today, bool(ens_fresh))
    with _cache_lock:
        if key in _cache:
            return _cache[key]

    data = copy.deepcopy(fc['data'])
    ens = None
    if ens_fresh:
        e = db.get_snapshot(conn, 'ensemble')
        ens = {**e['data'], 'fetchedAt': e['fetched_at']}
    runs = (db.get_snapshot(conn, 'runs') or {}).get('data') or {}
    trim_forecast(data, ens, today)
    out = {
        'schema': config.FORECAST_SCHEMA,
        'fetchedAt': fc['fetched_at'],  # download delle previsioni dalla fonte
        # incompleta: senza ensemble recente o senza metadati di un modello
        'incomplete': ens is None or any(runs.get(m['key']) is None for m in sources.MODELS),
        **data,
        'runs': {m['key']: runs.get(m['key']) for m in sources.MODELS},
        'ensemble': ens,
    }
    body = json.dumps(out, separators=(',', ':')).encode()
    etag = '"' + hashlib.sha1(repr(key).encode()).hexdigest()[:16] + '"'
    with _cache_lock:
        _cache.clear()  # basta l'ultima versione
        _cache[key] = (body, etag)
    return body, etag


def compose_station(conn):
    """Ultima misura con le letture delle ultime 2 ore (rainLog: istante, data locale, mm
    di oggi), da cui il frontend capisce se sta piovendo."""
    st = db.latest_station(conn)
    if not st:
        return None
    tz = ZoneInfo(config.TIMEZONE)
    log = [
        {'t': r['time'], 'day': datetime.fromtimestamp(r['time'] / 1000, tz).strftime('%Y-%m-%d'), 'mm': r['rainToday']}
        for r in db.station_since(conn, st['time'] - config.RAIN_LOG_S * 1000)
        if r.get('rainToday') is not None
    ]
    return {**st, 'rainLog': log}


def compose_normals(conn):
    n = db.get_snapshot(conn, 'normals')
    if not n:
        return None
    return {**n['data'], 'fetchedAt': n['fetched_at'], 'model': sources.NORMALS['name'],
            'from': sources.NORMALS['from'], 'to': sources.NORMALS['to']}


def compose_status(conn):
    return {
        'now': db.now_ms(),
        'snapshots': {n: db.snapshot_time(conn, n) for n in ('forecast', 'ensemble', 'runs', 'normals')},
        'station': (db.latest_station(conn) or {}).get('time'),
        'jobs': db.last_logs(conn),
    }


class Handler(SimpleHTTPRequestHandler):
    serve_static = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(config.ROOT), **kwargs)

    def end_headers(self):
        # API: il browser rivalida sempre (ETag → 304). File statici serviti in locale:
        # niente cache aggressiva durante lo sviluppo.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, status, body, etag=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(',', ':')).encode()
        if etag is None:
            etag = '"' + hashlib.sha1(body).hexdigest()[:16] + '"'
        # nginx, comprimendo la risposta, rende l'ETag "debole" (W/"…"): si confronta il valore.
        sent = [t.strip().removeprefix('W/') for t in (self.headers.get('If-None-Match') or '').split(',')]
        if etag in sent:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.end_headers()
            return
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('ETag', etag)
        if self.command != 'HEAD':
            self.end_headers()
            self.wfile.write(body)
        else:
            self.end_headers()

    def _api(self, name, query=None):
        conn = db.connect()
        try:
            if name == 'verify':
                q = query or {}
                try:
                    days, lead = int(q.get('days', ['30'])[0]), int(q.get('lead', ['1'])[0])
                except ValueError:
                    return self._json(400, {'error': 'parametri non validi'})
                return self._json(200, verify.compose_verify(conn, days, lead))
            if name == 'forecast':
                res = compose_forecast(conn, db.now_ms())
                if res:
                    return self._json(200, res[0], res[1])
            else:
                body = {'station': compose_station, 'normals': compose_normals, 'status': compose_status}.get(name)
                if body is None:
                    return self._json(404, {'error': 'risorsa sconosciuta'})
                data = body(conn)
                if data is not None:
                    return self._json(200, data)
            # Dati non ancora scaricati dai job (es. subito dopo l'installazione).
            return self._json(503, {'error': 'dati non ancora disponibili'})
        finally:
            conn.close()

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        if '/api/' in path:
            return self._api(path.rstrip('/').split('/api/')[-1], parse_qs(parts.query))
        if self.serve_static:
            return super().do_GET()
        return self._json(404, {'error': 'non trovato'})

    def do_HEAD(self):
        return self.do_GET()


def main(argv=None):
    p = argparse.ArgumentParser(description='API di Meteo Faenza')
    p.add_argument('--host', default=config.HOST)
    p.add_argument('--port', type=int, default=config.PORT)
    p.add_argument('--static', action='store_true', help='serve anche i file del frontend (sviluppo in locale)')
    args = p.parse_args(argv)
    Handler.serve_static = args.static
    db.connect().close()  # crea il database se manca
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'API in ascolto su http://{args.host}:{args.port}/' + (' (con i file statici)' if args.static else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
