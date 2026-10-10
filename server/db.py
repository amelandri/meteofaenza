"""Database SQLite: ultime previsioni, ensemble, metadati dei run, medie del periodo,
letture della centralina e registro degli aggiornamenti."""

import json
import sqlite3
import time

from . import config

SCHEMA = """
-- Ultimo dato di ogni tipo ('forecast', 'ensemble', 'runs', 'normals'), in JSON.
CREATE TABLE IF NOT EXISTS snapshots (
  name       TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,   -- ms, istante del download dalla fonte
  data       TEXT NOT NULL
);
-- Letture della centralina, una per istante di misura.
CREATE TABLE IF NOT EXISTS station_readings (
  time       INTEGER PRIMARY KEY, -- ms, istante della misura (currentTimeMillis)
  fetched_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
-- Registro dei job (esito, durata), per /api/status e per capire cosa non va.
CREATE TABLE IF NOT EXISTS fetch_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,      -- ms
  job     TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS fetch_log_job ON fetch_log (job, at);
-- Archivio delle previsioni per la verifica (server/verify.py): una riga per modello, run
-- e ora prevista (solo ore future rispetto al download). issued_at = quando la previsione
-- era disponibile (download del server), run_init = inizio del run (s).
CREATE TABLE IF NOT EXISTS forecast_archive (
  model      TEXT NOT NULL,        -- 'i2i' | 'eu'
  run_init   INTEGER NOT NULL,
  issued_at  INTEGER NOT NULL,     -- ms
  target     TEXT NOT NULL,        -- ora locale 'YYYY-MM-DDTHH:00' (pioggia dell'ora precedente)
  precip     REAL,
  temp       REAL,
  code       INTEGER,
  PRIMARY KEY (model, run_init, target)
);
CREATE INDEX IF NOT EXISTS forecast_archive_target ON forecast_archive (model, target, issued_at);
-- Archivio degli ensemble: per ogni download, ora e gruppo la maschera di bit degli scenari
-- con almeno 0,2 mm in quell'ora (bit i = scenario i) e quanti scenari hanno il dato: così
-- si ricalcola la probabilità di qualunque intervallo (OR delle maschere).
CREATE TABLE IF NOT EXISTS ensemble_archive (
  issued_at  INTEGER NOT NULL,     -- ms
  target     TEXT NOT NULL,
  grp        TEXT NOT NULL,        -- 'ICON-EU-EPS' | 'ICON-D2-EPS'
  mask       INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (issued_at, target, grp)
);
CREATE INDEX IF NOT EXISTS ensemble_archive_target ON ensemble_archive (target, issued_at);
-- Radar (server/radar.py). Ritagli intorno a Faenza (float16 compressi, NaN = fuori
-- copertura) per movimento e proiezione, e immagini PNG già pronte: si tengono RADAR_KEEP_S.
CREATE TABLE IF NOT EXISTS radar_frames (
  time       INTEGER PRIMARY KEY,  -- ms, istante dell'immagine radar
  fetched_at INTEGER NOT NULL,
  grid       BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS radar_images (
  name       TEXT PRIMARY KEY,     -- 'o<ms>' misurata, 'f<ms>_<minuti>' proiezione
  created_at INTEGER NOT NULL,
  png        BLOB NOT NULL
);
-- Per la verifica (storico come la centralina): pioggia del radar su Faenza a ogni immagine
-- e stima di ogni emissione per i minuti successivi (quota della zona con pioggia, mm/h).
CREATE TABLE IF NOT EXISTS radar_obs (
  time       INTEGER PRIMARY KEY,
  mmh        REAL                  -- media entro 2 km, NULL fuori copertura
);
CREATE TABLE IF NOT EXISTS radar_nowcast (
  issued     INTEGER NOT NULL,     -- ms, istante dell'immagine da cui parte la stima
  lead       INTEGER NOT NULL,     -- minuti
  frac       REAL,
  mmh        REAL,
  PRIMARY KEY (issued, lead)
);
"""


def now_ms():
    return int(time.time() * 1000)


def connect():
    """Connessione con WAL (letture dell'API e scritture dei job in parallelo)."""
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=10000')
    conn.executescript(SCHEMA)
    return conn


def get_snapshot(conn, name):
    """{'fetched_at': ms, 'data': dict} oppure None."""
    row = conn.execute('SELECT fetched_at, data FROM snapshots WHERE name = ?', (name,)).fetchone()
    return {'fetched_at': row['fetched_at'], 'data': json.loads(row['data'])} if row else None


def snapshot_time(conn, name):
    row = conn.execute('SELECT fetched_at FROM snapshots WHERE name = ?', (name,)).fetchone()
    return row['fetched_at'] if row else None


def put_snapshot(conn, name, data, fetched_at=None):
    conn.execute(
        'INSERT INTO snapshots (name, fetched_at, data) VALUES (?, ?, ?) '
        'ON CONFLICT(name) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
        (name, fetched_at or now_ms(), json.dumps(data, separators=(',', ':'))),
    )
    conn.commit()


def put_station(conn, reading):
    """Salva una lettura (ignorata se la misura è la stessa dell'ultima). True se nuova."""
    cur = conn.execute(
        'INSERT OR IGNORE INTO station_readings (time, fetched_at, data) VALUES (?, ?, ?)',
        (reading['time'], reading['fetchedAt'], json.dumps(reading, separators=(',', ':'))),
    )
    conn.commit()
    return cur.rowcount > 0


def latest_station(conn):
    row = conn.execute('SELECT data FROM station_readings ORDER BY time DESC LIMIT 1').fetchone()
    return json.loads(row['data']) if row else None


def station_since(conn, since_ms):
    rows = conn.execute('SELECT data FROM station_readings WHERE time >= ? ORDER BY time', (since_ms,))
    return [json.loads(r['data']) for r in rows]


def prune(conn):
    """Toglie letture e archivi oltre STATION_KEEP_DAYS e il registro oltre i 30 giorni."""
    conn.execute('DELETE FROM station_readings WHERE time < ?', (now_ms() - config.STATION_KEEP_DAYS * 86400000,))
    conn.execute('DELETE FROM fetch_log WHERE at < ?', (now_ms() - 30 * 86400000,))
    old = now_ms() - config.STATION_KEEP_DAYS * 86400000  # stesso storico delle letture
    conn.execute('DELETE FROM forecast_archive WHERE issued_at < ?', (old,))
    conn.execute('DELETE FROM ensemble_archive WHERE issued_at < ?', (old,))
    conn.execute('DELETE FROM radar_obs WHERE time < ?', (old,))
    conn.execute('DELETE FROM radar_nowcast WHERE issued < ?', (old,))
    recent = now_ms() - config.RADAR_KEEP_S * 1000
    conn.execute('DELETE FROM radar_frames WHERE time < ?', (recent,))
    conn.execute('DELETE FROM radar_images WHERE created_at < ?', (recent,))
    conn.commit()


def log(conn, job, ok, detail=''):
    conn.execute('INSERT INTO fetch_log (at, job, ok, detail) VALUES (?, ?, ?, ?)', (now_ms(), job, 1 if ok else 0, detail[:500]))
    conn.commit()


def last_logs(conn):
    """Ultimo esito di ogni job e ultimo successo."""
    out = {}
    for job in ('station', 'forecast', 'ensemble', 'normals', 'radar'):
        last = conn.execute('SELECT at, ok, detail FROM fetch_log WHERE job = ? ORDER BY at DESC LIMIT 1', (job,)).fetchone()
        good = conn.execute('SELECT at FROM fetch_log WHERE job = ? AND ok = 1 ORDER BY at DESC LIMIT 1', (job,)).fetchone()
        out[job] = {
            'lastRun': last['at'] if last else None,
            'lastOk': bool(last['ok']) if last else None,
            'lastDetail': last['detail'] if last else None,
            'lastSuccess': good['at'] if good else None,
        }
    return out
