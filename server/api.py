"""API JSON per il frontend (dietro nginx, che serve i file statici):

  GET api/forecast  previsioni + ensemble + metadati dei run (forma usata da js/app.js)
  GET api/station   ultima misura della centralina + letture delle ultime 2 ore (rainLog)
  GET api/normals   medie del periodo 1991–2020
  GET api/status    stato dei job (ultimo aggiornamento, errori)
  GET api/verify?days=30&lead=1
                    esiti della verifica dei giorni passati (previsione della sera prima,
                    lead=1, o di due giorni prima, lead=2)
  GET api/me        utente collegato
  GET api/settings  preferenze dell'utente: {"settings": {...} | null, "updatedAt"}
  POST api/settings {"settings": {chiave: valore}} → unisce e restituisce le preferenze
  POST api/login    {"username", "password"} → cookie di sessione (vedi auth.py)
  POST api/password {"current", "new"} → nuova password (chiude le altre sessioni)
  POST api/logout   chiude la sessione

Tutte le risorse richiedono l'accesso (cookie di sessione o "Authorization: Bearer <token>"),
tranne login / logout e api/status chiesto direttamente sul server (curl su 127.0.0.1:8085,
senza passare da nginx). Senza accesso: 401 {"error": "accesso richiesto"}.

Le risposte hanno un ETag: il browser rivalida (Cache-Control: no-cache) e riceve 304
finché i dati non cambiano. Le richieste non toccano mai le fonti esterne.

Avvio:  python3 -m server.api                      (solo API, per nginx)
        python3 -m server.api --static             (anche i file del frontend, in locale)
"""

import argparse
import copy
import hashlib
import json
import sqlite3
import sys
import threading
from http.cookies import CookieError, SimpleCookie
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

from urllib.parse import parse_qs, urlsplit

from . import alerts, auth, clouds, config, db, prefs, radar, rivers, sources, verify

_cache = {}  # chiave → (corpo, etag): JSON già composto delle previsioni
_offset_memo = (None, None)  # (download delle previsioni, utcOffset)
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
    sources.slice_block(h, sources.COMMON_HOURLY, max(0, first_today - 1))
    first_day = next((i for i, t in enumerate(d['time']) if t >= today), len(d['time']))
    if first_day > 0:
        sources.slice_block(d, sources.COMMON_DAILY, first_day)
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
    # Scarto da UTC delle previsioni salvate, ricordato per download: così a ogni richiesta
    # non serve rileggere tutto lo snapshot solo per sapere che giorno è.
    global _offset_memo
    fc = None
    if _offset_memo[0] != times[0]:
        fc = db.get_snapshot(conn, 'forecast')
        _offset_memo = (times[0], fc['data'].get('utcOffset'))
    today = _local_today(_offset_memo[1], now_ms)
    ens_fresh = times[1] and now_ms - times[1] <= config.ENSEMBLE_MAX_AGE_S * 1000
    key = (times, today, bool(ens_fresh))
    with _cache_lock:
        if key in _cache:
            return _cache[key]

    fc = fc or db.get_snapshot(conn, 'forecast')
    data = copy.deepcopy(fc['data'])
    ens = None
    if ens_fresh:
        e = db.get_snapshot(conn, 'ensemble')
        ens = {**e['data'], 'fetchedAt': e['fetched_at']}
        # Ensemble scaricato dall'altro lato del cambio dell'ora: i suoi orari hanno un altro
        # scarto da UTC (Open-Meteo usa quello del momento della richiesta) → stessi orari
        # delle previsioni.
        shift = ((data.get('utcOffset') or 0) - (ens.pop('utcOffset', None) or data.get('utcOffset') or 0)) // 3600
        if shift:
            ens['time'] = [(datetime.strptime(t, '%Y-%m-%dT%H:%M') + timedelta(hours=shift)).strftime('%Y-%m-%dT%H:00')
                           for t in ens['time']]
    runs = (db.get_snapshot(conn, 'runs') or {}).get('data') or {}
    trim_forecast(data, ens, today)
    # Dei modelli di supporto al frontend serve solo la pioggia (verdetto ora per ora);
    # temperatura e codice restano nel database per la verifica.
    for m in sources.SUPPORT_MODELS:
        series = data['hourly']['models'].get(m['key'])
        if series is not None:
            data['hourly']['models'][m['key']] = {'precipitation': series.get('precipitation', [])}
    out = {
        'schema': config.FORECAST_SCHEMA,
        'fetchedAt': fc['fetched_at'],  # download delle previsioni dalla fonte
        # incompleta: senza ensemble recente o senza metadati di un modello
        'incomplete': ens is None or any(runs.get(m['key']) is None for m in sources.MODELS),
        **data,
        'runs': {m['key']: runs.get(m['key']) for m in sources.ALL_MODELS},
        'ensemble': ens,
    }
    body = json.dumps(out, separators=(',', ':')).encode()
    # ETag dal contenuto: cambia solo se cambia la risposta (anche dopo un aggiornamento del
    # server che ne cambia la forma), non a ogni controllo dei metadati.
    etag = '"' + hashlib.sha1(body).hexdigest()[:16] + '"'
    with _cache_lock:
        _cache.clear()  # basta l'ultima versione
        _cache[key] = (body, etag)
    return body, etag


# Ultima pioggia misurata dalla centralina: istante dell'ultima lettura con mm in aumento
# (verify.rain_step(), che riconosce l'azzeramento all'01:00). Tenuta in memoria: a ogni
# nuova lettura si guardano solo le letture nuove; la prima volta si va a ritroso a blocchi di
# LAST_RAIN_STEP_DAYS giorni fino a trovarla (al massimo tutto lo storico).
LAST_RAIN_STEP_DAYS = 7
_last_rain = {'checked': None, 'time': None}
_last_rain_lock = threading.Lock()


def _rain_times(readings):
    """Istanti delle letture in cui i mm sono aumentati rispetto alla precedente."""
    return [b['time'] for a, b in zip(readings, readings[1:]) if verify.rain_step(a, b) > 0.05]


def last_rain(conn, st, tz):
    """{day: data locale, time: ms, mm: mm caduti quel giorno} dell'ultima pioggia, o None."""
    with _last_rain_lock:
        now = st['time']
        if _last_rain['checked'] is not None and _last_rain['checked'] <= now:
            # letture nuove dall'ultimo controllo (con la precedente, per il primo passo)
            new = db.station_between(conn, _last_rain['checked'], now)
            times = _rain_times(new)
            if times:
                _last_rain['time'] = times[-1]
        else:
            _last_rain['time'] = None
            end = now
            oldest = now - config.STATION_KEEP_DAYS * 86400000
            while end > oldest and _last_rain['time'] is None:
                start = end - LAST_RAIN_STEP_DAYS * 86400000
                chunk = db.station_between(conn, start, end)
                times = _rain_times(chunk)
                if times:
                    _last_rain['time'] = times[-1]
                # il blocco successivo (più vecchio) si sovrappone di un'ora a questo, così il
                # passo tra l'ultima lettura di quello e la prima di questo non si perde
                end = start + 3600000
        _last_rain['checked'] = now
        t = _last_rain['time']
    if t is None:
        return None
    # mm caduti in quel giorno locale (dalle letture del giorno, anche quella di mezzanotte)
    day = datetime.fromtimestamp(t / 1000, tz)
    start = int(day.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    rs = db.station_between(conn, start - verify.NEAR_MS, start + 86400000)
    mm = sum(verify.rain_step(a, b) for a, b in zip(rs, rs[1:]) if b['time'] > start)
    return {'day': day.strftime('%Y-%m-%d'), 'time': t, 'mm': round(mm, 1)}


def compose_station(conn):
    """Ultima misura con le letture delle ultime 2 ore (rainLog: istante, data locale, mm
    di oggi), da cui il frontend capisce se Sta piovendo."""
    st = db.latest_station(conn)
    if not st:
        return None
    tz = ZoneInfo(config.TIMEZONE)
    # I valori "di oggi" della centralina ripartono alle 01:00 con l'ora legale (vedi
    # verify.STATION_DAY_TZ): si ricalcolano da mezzanotte locale con le letture salvate.
    local = datetime.fromtimestamp(st['time'] / 1000, tz)
    start_ms = int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    since = min(start_ms - verify.NEAR_MS, st['time'] - config.RAIN_LOG_S * 1000)
    readings = db.station_since(conn, since)
    day_readings = [r for r in readings if r['time'] >= start_ms - verify.NEAR_MS]
    station_ok = verify.station_day_ok(st, tz)
    cum_mm = {}  # mm da mezzanotte locale per lettura, se calcolati
    res = verify.local_day(day_readings, start_ms, tz)
    if res:
        values, cum = res
        # Senza la lettura di mezzanotte (server fermo) il totale della centralina, se è già
        # di oggi, è più completo di quello ricalcolato dalla prima lettura.
        if values.pop('fromMidnight') or not station_ok:
            cum_mm = {r['time']: mm for r, mm in zip(day_readings, cum) if mm is not None and r['time'] >= start_ms}
        else:
            values['rainToday'] = st.get('rainToday')
        if not station_ok:
            # prima dell'azzeramento la direzione della raffica e i totali del mese / dell'anno
            # sono ancora quelli di ieri
            values['windMaxDirection'] = None
            yday = datetime.fromtimestamp(st['time'] / 1000, verify.STATION_DAY_TZ).date()
            if (yday.year, yday.month) != (local.year, local.month):
                values['rainMonth'] = values['rainToday']
            if yday.year != local.year:
                values['rainYear'] = values['rainToday']
        st = {**st, **values}
    st['radar'] = radar.compose(conn, full=False)  # riepilogo del radar, letto con la misura
    # nuvolosità osservata (radiazione della centralina o METAR), per correggere le previsioni
    # di oggi nel browser (cloudFix() in js/app.js)
    st['clouds'] = clouds.estimate(conn, st)
    st['alerts'] = alerts.compose(conn)  # allerte di oggi e domani della zona di Faenza
    st['lastRain'] = last_rain(conn, st, tz)  # ultimo giorno di pioggia (box della centralina)
    log = [
        {'t': r['time'], 'day': datetime.fromtimestamp(r['time'] / 1000, tz).strftime('%Y-%m-%d'),
         'mm': cum_mm.get(r['time'], r.get('rainToday'))}
        for r in readings
        if r['time'] >= st['time'] - config.RAIN_LOG_S * 1000 and cum_mm.get(r['time'], r.get('rainToday')) is not None
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
        'snapshots': {n: db.snapshot_time(conn, n) for n in ('forecast', 'ensemble', 'runs', 'normals', 'radar', 'rivers', 'alerts')},
        'station': (db.latest_station(conn) or {}).get('time'),
        'jobs': db.last_logs(conn),
    }


class Handler(SimpleHTTPRequestHandler):
    serve_static = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(config.ROOT), **kwargs)

    # Immagini radar: il nome comprende l'istante (e il riquadro), il contenuto non cambia mai;
    # il browser le tiene finché il server le conserva (RADAR_KEEP_S) senza ricontrollarle.
    # "private": risposte riservate a chi ha fatto l'accesso, mai in cache condivise.
    IMMUTABLE = f'private, max-age={config.RADAR_KEEP_S}, immutable'
    MAX_BODY = 4096  # login: corpo JSON piccolo

    def end_headers(self):
        # API: il browser rivalida sempre (ETag → 304), salvo le immagini radar. File statici
        # serviti in locale: niente cache aggressiva durante lo sviluppo.
        self.send_header('Cache-Control', getattr(self, '_cache_control', None) or 'private, no-cache')
        for h in getattr(self, '_extra_headers', ()):
            self.send_header(*h)
        super().end_headers()

    # --- Accesso -------------------------------------------------------------------------

    def _client(self):
        """Indirizzo del client: l'ultimo di X-Forwarded-For (aggiunto da nginx, non falsificabile
        dal client), altrimenti quello della connessione."""
        xff = self.headers.get('X-Forwarded-For')
        return xff.split(',')[-1].strip() if xff else self.client_address[0]

    def _direct_local(self):
        """Richiesta fatta direttamente sul server (non passata da nginx, che aggiunge sempre
        X-Forwarded-For)."""
        return not self.headers.get('X-Forwarded-For') and self.client_address[0] in ('127.0.0.1', '::1')

    def _cookie_token(self):
        c = self._cookies()
        return c[auth.COOKIE].value if auth.COOKIE in c else None

    def _bearer(self):
        h = self.headers.get('Authorization') or ''
        return h[7:].strip() if h.lower().startswith('bearer ') else None

    def _cookies(self):
        try:
            return SimpleCookie(self.headers.get('Cookie') or '')
        except CookieError:
            return SimpleCookie()

    def _set_cookie(self, token, max_age):
        """Cookie di sessione: HttpOnly (non leggibile da JavaScript), SameSite=Strict, Secure se
        la richiesta è arrivata in HTTPS (nginx: X-Forwarded-Proto), percorso = cartella
        dell'app (funziona anche in una sottocartella). Con lui il segnale auth.MARK_COOKIE
        (stessa durata; token vuoto = uscita: si tolgono entrambi)."""
        self._extra_headers.append(('Set-Cookie', f'{auth.COOKIE}={token}; {self._cookie_attrs(max_age)}; HttpOnly'))
        self._set_mark(max_age if token else 0)

    def _set_mark(self, max_age):
        self._extra_headers.append(('Set-Cookie', f'{auth.MARK_COOKIE}={"1" if max_age else ""}; {self._cookie_attrs(max_age)}'))

    def _cookie_attrs(self, max_age):
        path = urlsplit(self.path).path.split('/api/')[0] + '/'
        secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
        return f'Path={path}; Max-Age={max_age}; SameSite=Strict{secure}'

    def _user(self, conn):
        """Utente collegato (cookie o token personale), o None. Rinnova il cookie se la sessione
        è stata prolungata; rimette il segnale auth.MARK_COOKIE se manca (sessioni nate prima
        del segnale). Sessione del browser non valida (scaduta, chiusa da `users passwd`):
        toglie i cookie, così le pagine vanno subito al login."""
        cookie, bearer = self._cookie_token(), self._bearer()
        user, renewed = auth.check_token(conn, bearer or cookie)
        if bearer:
            return user
        if user and renewed:
            self._set_cookie(cookie, auth.SESSION_DAYS * 86400)
        elif user and auth.MARK_COOKIE not in self._cookies():
            self._set_mark(auth.SESSION_DAYS * 86400)
        elif not user and (cookie or auth.MARK_COOKIE in self._cookies()):
            self._set_cookie('', 0)
        return user

    def _json(self, status, body, etag=None, content_type='application/json; charset=utf-8', cache=None):
        self._cache_control = cache
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
        self.send_header('Content-Type', content_type)
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
            user = self._user(conn)
            if not user and not (name == 'status' and self._direct_local()):
                return self._json(401, {'error': 'accesso richiesto'})
            if name == 'me':
                return self._json(200, {'user': user})
            if name == 'settings':
                data, at = prefs.get(conn, user)
                return self._json(200, {'settings': data, 'updatedAt': at})
            if name == 'verify':
                q = query or {}
                try:
                    days, lead = int(q.get('days', ['30'])[0]), int(q.get('lead', ['1'])[0])
                except ValueError:
                    return self._json(400, {'error': 'parametri non validi'})
                return self._json(200, verify.compose_verify(conn, days, lead))
            if name.startswith('radar/'):
                # immagini dell'animazione: 'o<ms>.png' misurate, 'f<ms>_<minuti>.png' stimate
                png = radar.image(conn, name[len('radar/'):].removesuffix('.png'))
                if png is None:
                    return self._json(404, {'error': 'immagine non disponibile'})
                return self._json(200, png, content_type='image/png', cache=self.IMMUTABLE)
            if name == 'radar':
                data = radar.compose(conn)
                return self._json(200, data) if data else self._json(503, {'error': 'radar non disponibile'})
            if name == 'forecast':
                res = compose_forecast(conn, db.now_ms())
                if res:
                    return self._json(200, res[0], res[1])
            else:
                body = {'station': compose_station, 'normals': compose_normals, 'status': compose_status,
                        'rivers': rivers.compose}.get(name)
                if body is None:
                    return self._json(404, {'error': 'risorsa sconosciuta'})
                data = body(conn)
                if data is not None:
                    return self._json(200, data)
            # Dati non ancora scaricati dai job (es. subito dopo l'installazione).
            return self._json(503, {'error': 'dati non ancora disponibili'})
        finally:
            conn.close()

    def do_POST(self):
        self._cache_control = None
        self._extra_headers = []
        name = urlsplit(self.path).path.rstrip('/').split('/api/')[-1] if '/api/' in self.path else ''
        if name not in ('login', 'logout', 'settings', 'password'):
            return self._json(404, {'error': 'non trovato'})
        # Solo JSON: un modulo di un altro sito non può inviarlo senza il permesso del browser.
        if (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json':
            return self._json(415, {'error': 'richiesta non valida'})
        try:
            size = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            size = -1
        if size < 0 or size > self.MAX_BODY:
            return self._json(413, {'error': 'richiesta non valida'})
        try:
            data = json.loads(self.rfile.read(size) or b'{}')
        except ValueError:
            return self._json(400, {'error': 'richiesta non valida'})
        if not isinstance(data, dict):
            data = {}
        try:
            return self._post(name, data)
        except sqlite3.Error as err:
            # es. database non scrivibile dall'utente dell'API (file creati da root): lo si dice
            # al browser invece di chiudere la connessione, e lo si scrive nel log del servizio
            print(f'api/{name}: errore del database: {err}', file=sys.stderr)
            return self._json(500, {'error': 'errore del server (database): avvisa l\'amministratore'})

    def _post(self, name, data):
        conn = db.connect()
        try:
            if name == 'settings':
                user = self._user(conn)
                if not user:
                    return self._json(401, {'error': 'accesso richiesto'})
                patch = data.get('settings')
                if not isinstance(patch, dict):
                    return self._json(400, {'error': 'richiesta non valida'})
                saved, ignored = prefs.update(conn, user, patch)
                return self._json(200, {'settings': saved, 'ignored': ignored})
            if name == 'password':
                return self._change_password(conn, data)
            if name == 'logout':
                auth.end_session(conn, self._cookie_token())
                self._set_cookie('', 0)
                return self._json(200, {'ok': True})
            addr = self._client()
            if auth.blocked(addr):
                return self._json(429, {'error': 'troppi tentativi: riprova tra qualche minuto'})
            username, password = data.get('username'), data.get('password')
            user = auth.authenticate(conn, username, password) if isinstance(username, str) and isinstance(password, str) else None
            if not user:
                auth.record_failure(addr)
                return self._json(401, {'error': 'nome utente o password non validi'})
            auth.clear_failures(addr)
            self._set_cookie(auth.create_session(conn, user), auth.SESSION_DAYS * 86400)
            return self._json(200, {'user': user})
        finally:
            conn.close()

    def _change_password(self, conn, data):
        """Cambio della password dalle Impostazioni: serve la password attuale (tentativi
        sbagliati contati come quelli del login, stesso blocco). auth.set_password() chiude
        tutte le sessioni dell'utente (gli altri dispositivi tornano al login, i token
        personali restano): a questo browser se ne dà subito una nuova."""
        user = self._user(conn)
        if not user:
            return self._json(401, {'error': 'accesso richiesto'})
        addr = self._client()
        if auth.blocked(addr):
            return self._json(429, {'error': 'troppi tentativi: riprova tra qualche minuto'})
        current, new = data.get('current'), data.get('new')
        if not isinstance(current, str) or not isinstance(new, str):
            return self._json(400, {'error': 'richiesta non valida'})
        # 403, non 401: la sessione è valida, è sbagliata solo la password attuale
        if not auth.authenticate(conn, user, current):
            auth.record_failure(addr)
            return self._json(403, {'error': 'la password attuale non è corretta'})
        if new == current:
            return self._json(400, {'error': 'la nuova password è uguale a quella attuale'})
        try:
            auth.set_password(conn, user, new)
        except ValueError as err:
            return self._json(400, {'error': str(err)})
        auth.clear_failures(addr)
        self._set_cookie(auth.create_session(conn, user), auth.SESSION_DAYS * 86400)
        return self._json(200, {'ok': True})

    def do_GET(self):
        self._cache_control = None  # per richiesta (con keep-alive l'oggetto serve più richieste)
        self._extra_headers = []
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
