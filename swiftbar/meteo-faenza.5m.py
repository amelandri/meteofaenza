#!/usr/bin/env python3
# <xbar.title>Meteo Faenza</xbar.title>
# <xbar.version>1.0</xbar.version>
# <xbar.author>Alessandro Melandri</xbar.author>
# <xbar.desc>Misure della centralina di Faenza (Osservatorio "E. Torricelli") dal server di Meteo Faenza.</xbar.desc>
# <xbar.dependencies>python3</xbar.dependencies>
# <xbar.abouturl>https://meteofa.melandri.net/</xbar.abouturl>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
"""Plugin SwiftBar: temperatura della centralina di Faenza nella barra dei menu, e nel menu
tutte le misure della giornata (estremi, pioggia, vento, pressione, sole).

I dati arrivano dal server di Meteo Faenza (api/station, aggiornata ogni 10 minuti; per gli
scarti dalla media api/normals), non dalla centralina: il plugin non interroga fonti esterne.
Il nome del file decide l'intervallo di aggiornamento di SwiftBar (.5m. = ogni 5 minuti).

Installazione: copiare il file nella cartella dei plugin di SwiftBar e renderlo eseguibile
(chmod +x). Solo libreria standard di Python 3.
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

BASE_URL = os.environ.get('METEO_URL', 'https://meteofa.melandri.net').rstrip('/')
SITE_URL = f'{BASE_URL}/'
TIMEOUT = 10  # secondi

STALE_S = 30 * 60  # misura più vecchia di così: "non aggiornata"
# Pioggia in corso (come nell'app): aumento dei mm di oggi rispetto a una lettura di 8–40
# minuti prima, con misura attuale di al massimo 20 minuti.
RAIN_GAP_MIN_S, RAIN_GAP_MAX_S, RAIN_FRESH_S = 8 * 60, 40 * 60, 20 * 60
# Medie del periodo: cambiano una volta l'anno, si tengono in cache per una settimana.
NORMALS_CACHE = Path.home() / 'Library' / 'Caches' / 'meteo-faenza-normals.json'
NORMALS_CACHE_S = 7 * 24 * 3600

# Colori (chiaro, scuro) per SwiftBar: "color=chiaro,scuro".
RED = '#d32f2f,#ff6b6b'
BLUE = '#1565c0,#64a8ff'
RAIN = '#2563eb,#6aa1ff'
WARN = '#b07a05,#e7b43a'
DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO']


def get_json(path):
    req = urllib.request.Request(f'{BASE_URL}/{path}', headers={'User-Agent': 'MeteoFaenza-SwiftBar/1.0'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return json.load(res)


def normals():
    """Medie del periodo dal server, con cache locale (None se non disponibili)."""
    try:
        if NORMALS_CACHE.exists() and time.time() - NORMALS_CACHE.stat().st_mtime < NORMALS_CACHE_S:
            return json.loads(NORMALS_CACHE.read_text())
    except (OSError, ValueError):
        pass
    try:
        n = get_json('api/normals')
        NORMALS_CACHE.parent.mkdir(parents=True, exist_ok=True)
        NORMALS_CACHE.write_text(json.dumps(n))
        return n
    except Exception:  # medie accessorie: senza, niente scarti
        return None


def num(v, decimals=1):
    """Numero con il punto decimale; interi senza decimali se il valore è intero (15 mm)."""
    if v is None:
        return None
    if decimals == 'auto':
        return f'{v:.0f}' if float(v).is_integer() else f'{v:.1f}'
    return f'{v:.{decimals}f}'


def direction(deg):
    return DIRS[round(deg / 22.5) % 16] if deg is not None else ''


def at(t):
    return f' ({t})' if t else ''


def feels_like(st):
    """Temperatura percepita: indice di calore se fa più caldo del misurato (afa),
    temperatura apparente del vento se fa più freddo, altrimenti la temperatura."""
    t, hi, wc = st.get('temperature'), st.get('heatIndex'), st.get('windChill')
    if hi is not None and hi > t:
        return hi
    if wc is not None and wc < t:
        return wc
    return t


def rain_now(st):
    """(mm caduti, minuti) se sta piovendo secondo le ultime letture, altrimenti None."""
    if st.get('rainToday') is None or time.time() * 1000 - st['time'] > RAIN_FRESH_S * 1000:
        return None
    day = datetime.fromtimestamp(st['time'] / 1000).strftime('%Y-%m-%d')
    refs = [e for e in st.get('rainLog', [])
            if e.get('day') == day and RAIN_GAP_MIN_S * 1000 <= st['time'] - e['t'] <= RAIN_GAP_MAX_S * 1000]
    if not refs:
        return None
    ref = max(refs, key=lambda e: e['t'])
    mm = st['rainToday'] - ref['mm']
    return (mm, round((st['time'] - ref['t']) / 60000)) if mm > 0.05 else None


def anomaly(value, normal):
    """Scarto dalla media del periodo: " · +2.9° sulla media"."""
    if value is None or normal is None:
        return ''
    d = value - normal
    if abs(d) < 0.05:
        return ' · nella media'
    return f" · {'+' if d > 0 else '−'}{abs(d):.1f}° {'sopra' if d > 0 else 'sotto'} la media"


def line(text, **params):
    """Riga del menu con i parametri di SwiftBar (sfimage, color, href, …)."""
    extra = ' '.join(f'{k}={v}' for k, v in params.items() if v is not None)
    return f'{text} | {extra}' if extra else text


def item(label, value, unit='', when=None, sf=None, color=None, suffix=''):
    """Riga "Etichetta: valore unità (ora)"; niente riga se il valore manca."""
    if value is None:
        return None
    return line(f'{label}: {value}{unit}{at(when)}{suffix}', sfimage=sf, color=color)


def main():
    try:
        st = get_json('api/station')
    except Exception as err:
        print(line('—°', sfimage='thermometer.medium.slash'))
        print('---')
        print(line('Server di Meteo Faenza non raggiungibile', sfimage='exclamationmark.triangle', color=WARN))
        print(line(str(err)[:80], size=11))
        print('---')
        print(line('Apri Meteo Faenza', href=SITE_URL, sfimage='safari'))
        print(line('Aggiorna', refresh='true', sfimage='arrow.clockwise'))
        return

    now = time.time()
    age_s = now - st['time'] / 1000
    stale = age_s > STALE_S
    raining = rain_now(st)
    n = normals()
    k = None
    if n and len(n.get('tmax', [])) == 366:
        m = datetime.fromtimestamp(st['time'] / 1000)
        k = (datetime(2000, m.month, m.day) - datetime(2000, 1, 1)).days
    nmax = n['tmax'][k] if k is not None else None
    nmin = n['tmin'][k] if k is not None else None

    # --- Barra dei menu: temperatura, con l'ombrello se piove e il triangolo se vecchia
    icon = 'exclamationmark.triangle' if stale else 'cloud.rain' if raining else 'thermometer.medium'
    print(line(f"{num(st['temperature'])}°", sfimage=icon))
    print('---')

    # --- Temperature
    rows = [
        item('Massima', num(st.get('tMax')), ' °C', st.get('tMaxTime'), color=RED, suffix=anomaly(st.get('tMax'), nmax)),
        item('Minima', num(st.get('tMin')), ' °C', st.get('tMinTime'), color=BLUE, suffix=anomaly(st.get('tMin'), nmin)),
        item('Percepita', num(feels_like(st)), ' °C', sf='thermometer.medium'),
        item('Indice di calore', num(st.get('heatIndex')), ' °C', sf='thermometer.sun'),
        item('Temperatura apparente (vento)', num(st.get('windChill')), ' °C', sf='wind'),
        item('Punto di rugiada', num(st.get('dewPoint')), ' °C', sf='drop'),
    ]
    if nmax is not None:
        rows.append(item('Media del periodo', f'max {nmax:.1f} °C · min {nmin:.1f} °C', sf='chart.line.flattrend.xyaxis'))
    print('\n'.join(r for r in rows if r))
    print('---')

    # --- Pioggia, umidità, pressione, vento, radiazione
    wind = None
    if st.get('windSpeed') is not None:
        wind = f"{num(st['windSpeed'], 0)} km/h, {direction(st.get('windDirection'))} ({num(st.get('windDirection'), 0)}°)"
    gust = None
    if st.get('windMax') is not None:
        d = st.get('windMaxDirection')
        gust = f"{num(st['windMax'], 0)} km/h" + (f', {direction(d)} ({num(d, 0)}°)' if d is not None else '')
    gust_time = f", ore {st['windMaxTime']}" if st.get('windMaxTime') else ''
    rows = [
        item('Precipitazioni', num(st.get('rainToday')), ' mm', sf='cloud.rain'),
        line(f'Sta piovendo: +{raining[0]:.1f} mm negli ultimi {raining[1]} minuti', sfimage='umbrella', color=RAIN) if raining else None,
        item('Umidità', num(st.get('humidity'), 0), '%', sf='humidity'),
        item('Umidità massima', num(st.get('humidityMax'), 0), '%', st.get('humidityMaxTime'), sf='humidity.fill'),
        item('Umidità minima', num(st.get('humidityMin'), 0), '%', st.get('humidityMinTime'), sf='humidity'),
        item('Pressione', num(st.get('pressure')), ' hPa', sf='gauge.with.dots.needle.50percent'),
        item('Pressione massima', num(st.get('pressureMax')), ' hPa', st.get('pressureMaxTime'), sf='arrow.up'),
        item('Pressione minima', num(st.get('pressureMin')), ' hPa', st.get('pressureMinTime'), sf='arrow.down'),
        item('Vento', wind, sf='wind'),
        line(f'Raffica giornaliera: {gust}{gust_time}', sfimage='wind') if gust else None,
        item('Radiazione solare', num(st.get('radiation')), ' W/m²', sf='sun.max'),
        item('Massima radiazione', num(st.get('radiationMax')), ' W/m²', st.get('radiationMaxTime'), sf='sun.max.fill'),
    ]
    print('\n'.join(r for r in rows if r))

    # --- Totali del mese e dell'anno (solo se il server li fornisce)
    rows = [
        item('Precipitazioni del mese', num(st.get('rainMonth'), 'auto'), ' mm', sf='calendar'),
        item("Precipitazioni dell'anno", num(st.get('rainYear'), 'auto'), ' mm', sf='calendar.badge.clock'),
    ]
    rows = [r for r in rows if r]
    if rows:
        print('---')
        print('\n'.join(rows))

    # --- Sole
    rows = [
        item('Alba', st.get('sunrise'), sf='sunrise'),
        item('Mezzogiorno solare', st.get('sunNoon'), sf='sun.max'),
        item('Tramonto', st.get('sunset'), sf='sunset'),
        item('Ora solare vera', st.get('trueSolarTime'), sf='clock'),
        item('Azimut solare', num(st.get('sunAzimuth')), '°', sf='safari'),
        item('Altezza solare', num(st.get('sunAltitude')), '°', sf='angle'),
        item('Trasparenza del cielo', num(st.get('skyTransparency'), 0), '%', sf='eye'),
    ]
    rows = [r for r in rows if r]
    if rows:
        print('---')
        print('\n'.join(rows))

    # --- Stato e azioni
    print('---')
    measured = datetime.fromtimestamp(st['time'] / 1000).strftime('%H:%M')
    ago = f'{round(age_s / 60)} min fa' if age_s < 3600 else f'{age_s / 3600:.0f} h fa'
    if stale:
        print(line(f'Misura non aggiornata: delle {measured} ({ago})', sfimage='exclamationmark.triangle', color=WARN))
    else:
        print(line(f'Misurato alle {measured} ({ago})', sfimage='clock.arrow.circlepath', size=12))
    print(line('Osservatorio "E. Torricelli" – meteofaenza.it', href='https://www.meteofaenza.it/', size=12))
    print(line('Apri Meteo Faenza', href=SITE_URL, sfimage='safari'))
    print(line('Aggiorna', refresh='true', sfimage='arrow.clockwise'))


if __name__ == '__main__':
    try:
        main()
    except Exception as err:  # mai una traccia nella barra dei menu
        print(line('—°', sfimage='exclamationmark.triangle'))
        print('---')
        print(f'Errore del plugin: {err}'[:120])
        sys.exit(0)
