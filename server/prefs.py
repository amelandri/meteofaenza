"""Preferenze degli utenti (tema, modelli mostrati, grafico, sezioni, verifica), salvate nel
database per utente (tabella user_settings) e servite da api/settings.

Il browser ne tiene solo una copia di lettura (meteo:settings in js/storage.js) per applicare il
tema prima del primo disegno e per l'uso offline; la fonte è il database. Ogni valore ricevuto
si controlla qui: solo le chiavi di PREF_VALUES, con un valore ammesso e dello stesso tipo
(True non vale come 1). PREF_VALUES deve restare uguale a quello di js/storage.js.
"""

import json

from . import db

PREF_VALUES = {
    'theme': ['auto', 'light', 'dark'],
    'models': ['both', 'i2i', 'eu'],
    'variable': ['rain', 'temp', 'wind', 'cloud', 'humidity', 'pressure'],
    'range': ['24', '72', 'all'],
    'chartFrom': ['now', 'today'],
    'showAllHours': [False, True],
    'hourlyOpen': [False, True],
    'radarOpen': [False, True],
    'riversOpen': [False, True],
    'verifyLead': [1, 2],
    'verifyDays': [7, 30],
}


def valid(key, value):
    return key in PREF_VALUES and any(type(value) is type(v) and value == v for v in PREF_VALUES[key])


def get(conn, username):
    """(preferenze salvate, istante dell'ultima modifica in ms) o (None, None) se l'utente
    non ne ha ancora (il browser può allora inviare quelle che aveva salvato in locale)."""
    row = conn.execute('SELECT data, updated_at FROM user_settings WHERE username = ?', (username,)).fetchone()
    if not row:
        return None, None
    data = json.loads(row['data'])
    return {k: v for k, v in data.items() if valid(k, v)}, row['updated_at']


def update(conn, username, patch):
    """Unisce `patch` alle preferenze salvate. Restituisce (preferenze, chiavi scartate)."""
    current, _ = get(conn, username)
    current = current or {}
    ignored = []
    for k, v in (patch or {}).items():
        if valid(k, v):
            current[k] = v
        else:
            ignored.append(k)
    now = db.now_ms()
    conn.execute('INSERT INTO user_settings (username, data, updated_at) VALUES (?, ?, ?) '
                 'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
                 (username, json.dumps(current, separators=(',', ':')), now))
    conn.commit()
    return current, ignored
