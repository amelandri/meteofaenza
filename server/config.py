"""Configurazione del server: località, percorsi, frequenze di aggiornamento.

I valori si possono cambiare con variabili d'ambiente (utile su server diversi), senza
toccare il codice:
  METEO_DB    percorso del database SQLite (predefinito: <repo>/data/meteo.db)
  METEO_HOST  indirizzo su cui ascolta l'API (predefinito: 127.0.0.1, dietro nginx)
  METEO_PORT  porta dell'API (predefinito: 8085)
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Località fissa: la stessa di LOCATION in js/app.js (il frontend mostra il nome).
LAT = 44.29007
LON = 11.87948
TIMEZONE = 'Europe/Rome'

DB_PATH = Path(os.environ.get('METEO_DB', ROOT / 'data' / 'meteo.db'))
HOST = os.environ.get('METEO_HOST', '127.0.0.1')
PORT = int(os.environ.get('METEO_PORT', '8085'))

# Intestazione User-Agent delle richieste alle fonti esterne.
USER_AGENT = 'MeteoFaenza/1.0 (server privato, aggiornamenti via cron)'
HTTP_TIMEOUT = 30  # secondi per ogni richiesta esterna

# --- Frequenze (i job sono lanciati da cron: vedi deploy/crontab) -------------------
# Previsioni deterministiche: il job controlla ogni 15 minuti i metadati dei modelli
# (richieste minuscole) e scarica le previsioni solo se è uscito un nuovo run di ICON-2I
# (ogni 12 h) o di ICON-EU (ogni 3 h), oppure se quelle salvate hanno più di 6 ore.
FORECAST_MAX_AGE_S = 6 * 3600
# Ensemble: i loro metadati non sono affidabili (restano fermi per giorni), quindi si
# riscaricano a intervallo fisso: ogni 3 ore, la frequenza di ICON-D2-EPS (ICON-EU-EPS
# esce ogni 6). Oltre 12 ore non si servono più (meglio la stima di riserva).
ENSEMBLE_EVERY_S = 3 * 3600
ENSEMBLE_MAX_AGE_S = 12 * 3600
# Medie del periodo 1991–2020: non cambiano. Il job gira ogni giorno ma scarica solo se
# mancano o hanno più di un anno (anche dopo un errore, es. 429, riprova il giorno dopo).
NORMALS_MAX_AGE_S = 365 * 24 * 3600

# Centralina: letta ogni 10 minuti; storico conservato per eventuali verifiche future.
STATION_KEEP_DAYS = 400
RAIN_LOG_S = 2 * 3600  # letture restituite al frontend per capire se Sta piovendo

# Radar (server/radar.py): un'immagine ogni 5 minuti, pubblicata ~7–8 minuti dopo; il job
# gira ogni 5 minuti. Ritagli e immagini si tengono 3 ore (animazione dell'ultima ora e
# calcolo del movimento), il dato su Faenza e le stime per la verifica come la centralina.
# Oltre RADAR_MAX_AGE_S la stima non si serve più (radar fermo o job che non gira).
RADAR_KEEP_S = 3 * 3600
RADAR_MAX_AGE_S = 30 * 60

# Forma dei dati delle previsioni servite: deve coincidere con FORECAST_SCHEMA di
# js/storage.js (il frontend scarta le cache con schema diverso).
FORECAST_SCHEMA = 4
