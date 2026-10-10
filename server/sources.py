"""Fonti esterne: previsioni, ensemble e metadati dei run (Open-Meteo), medie del periodo
(archivio Open-Meteo, ERA5-Land) e misure della centralina (meteofaenza.it).

Le funzioni scaricano e normalizzano i dati nella stessa forma che usa il frontend
(prima calcolata nel browser da js/api.js e js/station.js).
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from . import config

FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
# Metadati dei run: per ICON-EU il dataset è dwd_icon_eu, non icon_eu.
META_URL = 'https://api.open-meteo.com/data/{model}/static/meta.json'
ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble'
ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
# File della centralina: variabili JavaScript stringa (var temperature = '17.2';). Lato
# server non c'è il problema del CORS e il file non viene più eseguito nel browser.
STATION_URL = 'https://www.meteofaenza.it/dati/today/data.js'

MODELS = [
    {'key': 'i2i', 'id': 'italia_meteo_arpae_icon_2i', 'meta': 'italia_meteo_arpae_icon_2i'},
    {'key': 'eu', 'id': 'icon_eu', 'meta': 'dwd_icon_eu'},
]
# Modelli "di supporto": non mostrati come colonne, votano nel verdetto dei tragitti. Ad alta
# risoluzione e aggiornati ogni 3 ore (ICON-2I ogni 12), coprono le prime ~48 ore. Si scarica
# solo la pioggia (al frontend) più temperatura e codice per l'archivio della verifica.
SUPPORT_MODELS = [
    {'key': 'd2', 'id': 'icon_d2', 'meta': 'dwd_icon_d2'},
    {'key': 'arome', 'id': 'meteofrance_arome_france_hd', 'meta': 'meteofrance_arome_france_hd'},
]
SUPPORT_VARS = ['precipitation', 'temperature_2m', 'weather_code']
ALL_MODELS = MODELS + SUPPORT_MODELS
# Ensemble per la probabilità di pioggia: ICON-EU-EPS (40 scenari, ~5 giorni, ogni 3 ore oltre
# le ~48 ore), ICON-D2-EPS (20 scenari a 2,2 km, ~2 giorni) ed ECMWF ENS (51 scenari, 6 giorni,
# dati ogni 3 ore). `suffix`: suffisso delle chiavi nella risposta, se diverso dall'id.
ENSEMBLE_MODELS = [
    {'id': 'icon_eu_eps', 'name': 'ICON-EU-EPS'},
    {'id': 'icon_d2_eps', 'name': 'ICON-D2-EPS'},
    {'id': 'ecmwf_ifs025', 'suffix': 'ecmwf_ifs025_ensemble', 'name': 'ECMWF ENS'},
]
HOURLY_VARS = [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation',
    'snowfall', 'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m',
    'wind_gusts_10m', 'pressure_msl', 'is_day',
]
DAILY_VARS = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'wind_gusts_10m_max']
# Dati comuni ai modelli, salvati fuori da `models` (vedi CLAUDE.md, "Dati comuni").
COMMON_HOURLY = ['precipitation_probability']
COMMON_DAILY = ['sunrise', 'sunset']

# Medie del periodo: trentennio 1991–2020, ERA5-Land, media mobile di ±7 giorni.
NORMALS = {'model': 'era5_land', 'name': 'ERA5-Land', 'from': 1991, 'to': 2020, 'half_window': 7}


class SourceError(Exception):
    """Errore di una fonte esterna, con messaggio leggibile (finisce nel registro)."""


def now_ms():
    return int(time.time() * 1000)


def _get(url, params=None):
    if params:
        url = f'{url}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(url, headers={'User-Agent': config.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        reason = ''
        try:
            reason = json.loads(err.read()).get('reason', '')
        except Exception:  # risposta non JSON
            pass
        if err.code == 429:
            raise SourceError('troppe richieste (HTTP 429)') from err
        raise SourceError(f'HTTP {err.code} {reason}'.strip()) from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise SourceError(f'connessione non riuscita: {err}') from err


def get_json(url, params=None):
    try:
        return json.loads(_get(url, params))
    except json.JSONDecodeError as err:
        raise SourceError('risposta non valida') from err


def _coords():
    return {'latitude': f'{config.LAT:.4f}', 'longitude': f'{config.LON:.4f}'}


# --- Metadati dei run --------------------------------------------------------------

def fetch_runs():
    """{chiave modello: {init, available, interval} | None} (secondi Unix)."""
    runs = {}
    for m in ALL_MODELS:
        try:
            meta = get_json(META_URL.format(model=m['meta']))
            runs[m['key']] = {
                'init': meta['last_run_initialisation_time'],
                'available': meta['last_run_availability_time'],
                'interval': meta['update_interval_seconds'],
            }
        except (SourceError, KeyError):
            runs[m['key']] = None
    return runs


# --- Previsioni deterministiche ---------------------------------------------------

def fetch_forecast():
    """Previsioni dei due modelli (e dei modelli di supporto, solo SUPPORT_VARS orari),
    normalizzate in
    {timezone, tzAbbr, utcOffset, gridElevation, hourly: {time, models: {i2i: {var: []}, eu, d2, arome},
    precipitation_probability}, daily: {time, models, sunrise, sunset}}.
    Comprende il giorno prima (past_days=1): il taglio a "da ieri alle 23" si fa quando i
    dati vengono serviti (api.trim_forecast), così resta giusto anche dopo mezzanotte."""
    data = get_json(FORECAST_URL, {
        **_coords(),
        'hourly': ','.join(HOURLY_VARS + COMMON_HOURLY),
        'daily': ','.join(DAILY_VARS + COMMON_DAILY),
        'models': ','.join(m['id'] for m in ALL_MODELS),
        'forecast_days': 6,
        'past_days': 1,
        'timezone': 'auto',
        'wind_speed_unit': 'kmh',
    })

    def pick(block, names, support=()):
        return {'time': block['time'], 'models': {
            **{m['key']: {v: block.get(f"{v}_{m['id']}") or [] for v in names} for m in MODELS},
            **{m['key']: {v: block.get(f"{v}_{m['id']}") or [] for v in SUPPORT_VARS} for m in support},
        }}

    def common(block, v):
        # Prima serie con almeno un valore (senza suffisso o di uno dei modelli).
        for arr in [block.get(v)] + [block.get(f"{v}_{m['id']}") for m in MODELS]:
            if isinstance(arr, list) and any(x is not None for x in arr):
                return arr
        return []

    hourly = pick(data['hourly'], HOURLY_VARS, SUPPORT_MODELS)
    daily = pick(data['daily'], DAILY_VARS)
    for v in COMMON_HOURLY:
        hourly[v] = common(data['hourly'], v)
    for v in COMMON_DAILY:
        daily[v] = common(data['daily'], v)

    # Taglia la coda oraria in cui nessun modello principale ha dati.
    last = -1
    for m in MODELS:
        t = hourly['models'][m['key']]['temperature_2m']
        for i in range(len(t) - 1, last, -1):
            if t[i] is not None:
                last = i
                break
    if last >= 0:
        slice_block(hourly, COMMON_HOURLY, 0, last + 1)

    return {
        'timezone': data.get('timezone'),
        'tzAbbr': data.get('timezone_abbreviation'),
        'utcOffset': data.get('utc_offset_seconds', 0),
        'gridElevation': data.get('elevation'),
        'hourly': hourly,
        'daily': daily,
    }


def slice_block(block, common, start, end=None):
    """Taglia le serie di un blocco (orario o giornaliero) all'intervallo [start, end)."""
    block['time'] = block['time'][start:end]
    for v in common:
        block[v] = block[v][start:end]
    for series in block['models'].values():
        for v in series:
            series[v] = series[v][start:end]


# --- Ensemble ------------------------------------------------------------------------

def fetch_ensemble():
    """{time, groups: [{model, members: [[mm per ora], …]}]}: precipitazione oraria di
    ogni scenario. Con più modelli le chiavi hanno il suffisso del modello
    (precipitation_memberNN_icon_eu_eps); si scartano gli ensemble senza valori."""
    data = get_json(ENSEMBLE_URL, {
        **_coords(),
        'hourly': 'precipitation',
        'models': ','.join(m['id'] for m in ENSEMBLE_MODELS),
        'forecast_days': 6,
        'past_days': 1,
        'timezone': 'auto',
    })
    h = data['hourly']
    groups = []
    for m in ENSEMBLE_MODELS:
        key = re.compile(rf"^precipitation(_member\d+)?_{m.get('suffix', m['id'])}$")
        members = [h[k] for k in h if key.match(k)]
        if any(v is not None for s in members for v in s):
            groups.append({'model': m['name'], 'members': members})
    if not groups:
        raise SourceError('ensemble senza dati')
    return {'time': h['time'], 'groups': groups}


# --- Medie del periodo -------------------------------------------------------------

def day_of_year(mmdd):
    """Posizione di "MM-DD" nell'anno bisestile di riferimento (0 = 1 gennaio … 365),
    come dayOfYear() del frontend."""
    m, d = int(mmdd[:2]), int(mmdd[3:5])
    return (date(2000, m, d) - date(2000, 1, 1)).days


def compute_normals(times, values, half_window=NORMALS['half_window']):
    """Media per giorno dell'anno su tutti gli anni, poi media mobile circolare di
    ±half_window giorni pesata con i conteggi (il 29 febbraio ha meno anni)."""
    total, count = [0.0] * 366, [0] * 366
    for t, v in zip(times, values):
        if v is None:
            continue
        k = day_of_year(t[5:10])
        total[k] += v
        count[k] += 1
    out = []
    for k in range(366):
        s = c = 0
        for j in range(-half_window, half_window + 1):
            h = (k + j) % 366
            s += total[h]
            c += count[h]
        out.append(round(s / c, 1) if c else None)
    return out


def fetch_normals():
    """{tmax: [366], tmin: [366]} (°C, un decimale), indicizzati con day_of_year()."""
    data = get_json(ARCHIVE_URL, {
        **_coords(),
        'start_date': f"{NORMALS['from']}-01-01",
        'end_date': f"{NORMALS['to']}-12-31",
        'daily': 'temperature_2m_max,temperature_2m_min',
        'models': NORMALS['model'],
        'timezone': 'auto',
    })
    d = data['daily']
    tmax = compute_normals(d['time'], d['temperature_2m_max'])
    tmin = compute_normals(d['time'], d['temperature_2m_min'])
    if not any(v is not None for v in tmax):
        raise SourceError('medie del periodo non disponibili')
    return {'tmax': tmax, 'tmin': tmin}


# --- Centralina ----------------------------------------------------------------------

_JS_VAR = re.compile(r"var\s+(\w+)\s*=\s*'([^']*)'")


def _num(v):
    try:
        return float(v) if v is not None and str(v).strip() != '' else None
    except ValueError:
        return None


def _hhmm(v):
    return v.zfill(5) if isinstance(v, str) and re.fullmatch(r'\d{1,2}:\d{2}', v) else None


def parse_station(text, fetched_at=None):
    """Lettura della centralina dal file data.js (stessi campi di js/station.js prima)."""
    w = dict(_JS_VAR.findall(text))
    t = _num(w.get('currentTimeMillis'))
    temperature = _num(w.get('temperature'))
    if not t or temperature is None:
        raise SourceError('dati della centralina non validi')
    return {
        'time': int(t),  # istante della misura (ms)
        'temperature': temperature,
        'tMin': _num(w.get('temperatureMin')), 'tMinTime': _hhmm(w.get('temperatureMinTime')),
        'tMax': _num(w.get('temperatureMax')), 'tMaxTime': _hhmm(w.get('temperatureMaxTime')),
        'humidity': _num(w.get('humidity')),
        'pressure': _num(w.get('pressure')),
        'windSpeed': _num(w.get('windSpeed')),  # km/h
        'windDirection': _num(w.get('windDirection')),  # gradi, provenienza
        'windMax': _num(w.get('windSpeedMax')), 'windMaxTime': _hhmm(w.get('windSpeedMaxTime')),
        'rainToday': _num(w.get('rainfall')),  # mm da mezzanotte
        'dewPoint': _num(w.get('dewPoint')),
        'heatIndex': _num(w.get('heatIndex')),
        'windChill': _num(w.get('windChill')),
        'radiation': _num(w.get('radiation')),  # W/m²
        # Estremi e totali della giornata (usati dal plugin SwiftBar, swiftbar/)
        'humidityMin': _num(w.get('humidityMin')), 'humidityMinTime': _hhmm(w.get('humidityMinTime')),
        'humidityMax': _num(w.get('humidityMax')), 'humidityMaxTime': _hhmm(w.get('humidityMaxTime')),
        'pressureMin': _num(w.get('pressureMin')), 'pressureMinTime': _hhmm(w.get('pressureMinTime')),
        'pressureMax': _num(w.get('pressureMax')), 'pressureMaxTime': _hhmm(w.get('pressureMaxTime')),
        'windMaxDirection': _num(w.get('windDirectionOfMaxSpeed')),  # gradi, provenienza della raffica
        'rainMonth': _num(w.get('rainfallMonth')),  # mm dall'inizio del mese
        'rainYear': _num(w.get('rainfallYear')),  # mm dall'inizio dell'anno
        'radiationMax': _num(w.get('radiationMax')), 'radiationMaxTime': _hhmm(w.get('radiationMaxTime')),
        # Sole (calcolati dalla centralina)
        'sunrise': _hhmm(w.get('sunrise')), 'sunset': _hhmm(w.get('sunset')), 'sunNoon': _hhmm(w.get('sunNoon')),
        'trueSolarTime': _hhmm(w.get('trueSolarTime')),
        'sunAzimuth': _num(w.get('sunAzimuth')),  # gradi
        'sunAltitude': _num(w.get('sunAltitude')),  # gradi sull'orizzonte
        'skyTransparency': _num(w.get('skytransparency')),  # %
        'fetchedAt': fetched_at or now_ms(),
    }


def fetch_station():
    text = _get(STATION_URL, {'t': now_ms()}).decode('utf-8', errors='replace')
    return parse_station(text)
