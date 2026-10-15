"""Accesso all'app: utenti, password, sessioni e token personali.

- Password: mai salvate in chiaro né cifrate in modo reversibile. Si salva solo un hash scrypt
  con sale casuale ("scrypt$n$r$p$sale$hash", base64): dall'hash non si risale alla password,
  e due utenti con la stessa password hanno hash diversi. Se l'OpenSSL di Python non ha scrypt
  si ripiega su PBKDF2-SHA256 ("pbkdf2$iterazioni$sale$hash"). La verifica confronta in tempo
  costante.
- Sessioni del browser: token casuale (32 byte) nel cookie `meteo_session` (HttpOnly,
  SameSite=Strict, Secure in HTTPS); nel database solo il suo SHA-256, così chi legge il
  database non può usare le sessioni. Durano SESSION_DAYS (30) e si rinnovano usando l'app
  (al più una volta al giorno).
- Token personali (es. plugin SwiftBar): stessi token, senza scadenza, inviati con
  "Authorization: Bearer <token>"; revocabili con `python3 -m server.users revoke`.
- Tentativi di accesso: dopo MAX_FAILURES errori in FAIL_WINDOW_S dallo stesso indirizzo il
  login risponde 429 per il resto della finestra (in memoria, si azzera al riavvio).

Gli utenti si creano solo dal server: python3 -m server.users add <nome> (vedi users.py).
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time

from . import db

SESSION_DAYS = 30
RENEW_AFTER_S = 24 * 3600  # rinnovo della scadenza al più una volta al giorno
COOKIE = 'meteo_session'
MIN_PASSWORD = 8
MAX_FAILURES = 5
FAIL_WINDOW_S = 15 * 60

# scrypt: ~16 MB di memoria e qualche decina di ms per verifica (rende lenti i tentativi a tappeto)
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
PBKDF2_ITER = 600_000


def _b64(b):
    return base64.b64encode(b).decode()


def hash_password(password):
    salt = secrets.token_bytes(16)
    if hasattr(hashlib, 'scrypt'):
        h = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024, dklen=32)
        return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(h)}'
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, PBKDF2_ITER)
    return f'pbkdf2${PBKDF2_ITER}${_b64(salt)}${_b64(h)}'


def check_password(password, stored):
    try:
        kind, *parts = stored.split('$')
        if kind == 'scrypt':
            n, r, p, salt, h = parts
            got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                                 maxmem=64 * 1024 * 1024, dklen=len(base64.b64decode(h)))
        elif kind == 'pbkdf2':
            it, salt, h = parts
            got = hashlib.pbkdf2_hmac('sha256', password.encode(), base64.b64decode(salt), int(it))
        else:
            return False
        return hmac.compare_digest(got, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


# Hash di una password a caso: per un utente inesistente si fa comunque una verifica, così
# il tempo di risposta non rivela quali nomi esistono.
_DUMMY = None


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


# --- Utenti --------------------------------------------------------------------------

def add_user(conn, username, password):
    username = username.strip()
    if not username or len(username) > 64:
        raise ValueError('nome utente non valido')
    if len(password) < MIN_PASSWORD:
        raise ValueError(f'la password deve avere almeno {MIN_PASSWORD} caratteri')
    if conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
        raise ValueError(f'l\'utente "{username}" esiste già')
    conn.execute('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)',
                 (username, hash_password(password), db.now_ms()))
    conn.commit()


def set_password(conn, username, password):
    if len(password) < MIN_PASSWORD:
        raise ValueError(f'la password deve avere almeno {MIN_PASSWORD} caratteri')
    cur = conn.execute('UPDATE users SET pw_hash = ? WHERE username = ?', (hash_password(password), username))
    if not cur.rowcount:
        raise ValueError(f'utente "{username}" inesistente')
    # una password nuova chiude le sessioni aperte (i token personali restano)
    conn.execute("DELETE FROM sessions WHERE username = ? AND kind = 'session'", (username,))
    conn.commit()


def delete_user(conn, username):
    cur = conn.execute('DELETE FROM users WHERE username = ?', (username,))
    conn.execute('DELETE FROM sessions WHERE username = ?', (username,))
    conn.execute('DELETE FROM user_settings WHERE username = ?', (username,))
    conn.commit()
    if not cur.rowcount:
        raise ValueError(f'utente "{username}" inesistente')


def list_users(conn):
    return [dict(r) for r in conn.execute('SELECT username, created_at, last_login FROM users ORDER BY username')]


def authenticate(conn, username, password):
    """Nome utente se la password è giusta, altrimenti None."""
    global _DUMMY
    row = conn.execute('SELECT username, pw_hash FROM users WHERE username = ?', ((username or '').strip(),)).fetchone()
    if not row:
        _DUMMY = _DUMMY or hash_password(secrets.token_hex(8))
        check_password(password or '', _DUMMY)
        return None
    if not check_password(password or '', row['pw_hash']):
        return None
    conn.execute('UPDATE users SET last_login = ? WHERE username = ?', (db.now_ms(), row['username']))
    conn.commit()
    return row['username']


# --- Sessioni e token ------------------------------------------------------------------

def create_session(conn, username):
    token = secrets.token_urlsafe(32)
    now = db.now_ms()
    conn.execute('INSERT INTO sessions (token_hash, username, kind, label, created_at, expires_at, renewed_at) '
                 "VALUES (?, ?, 'session', NULL, ?, ?, ?)",
                 (_token_hash(token), username, now, now + SESSION_DAYS * 86400000, now))
    conn.commit()
    return token


def create_token(conn, username, label=''):
    if not conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
        raise ValueError(f'utente "{username}" inesistente')
    token = secrets.token_urlsafe(32)
    now = db.now_ms()
    conn.execute('INSERT INTO sessions (token_hash, username, kind, label, created_at, expires_at, renewed_at) '
                 "VALUES (?, ?, 'token', ?, ?, NULL, ?)", (_token_hash(token), username, label or None, now, now))
    conn.commit()
    return token


def check_token(conn, token):
    """(nome utente, rinnovata) per un token valido, altrimenti (None, False). Una sessione del
    browser usata dopo più di RENEW_AFTER_S dall'ultimo rinnovo riparte da SESSION_DAYS: in quel
    caso il chiamante rimanda il cookie con la nuova scadenza."""
    if not token:
        return None, False
    now = db.now_ms()
    row = conn.execute('SELECT s.username, s.kind, s.expires_at, s.renewed_at FROM sessions s '
                       'JOIN users u ON u.username = s.username WHERE s.token_hash = ?', (_token_hash(token),)).fetchone()
    if not row or (row['expires_at'] is not None and row['expires_at'] < now):
        return None, False
    if row['kind'] == 'session' and now - row['renewed_at'] > RENEW_AFTER_S * 1000:
        conn.execute('UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE token_hash = ?',
                     (now + SESSION_DAYS * 86400000, now, _token_hash(token)))
        conn.commit()
        return row['username'], True
    return row['username'], False


def end_session(conn, token):
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ? AND kind = 'session'", (_token_hash(token),))
        conn.commit()


def revoke(conn, username, tokens_only=False):
    """Chiude le sessioni e revoca i token di un utente (solo i token con tokens_only)."""
    q = 'DELETE FROM sessions WHERE username = ?' + (" AND kind = 'token'" if tokens_only else '')
    n = conn.execute(q, (username,)).rowcount
    conn.commit()
    return n


def list_tokens(conn):
    return [dict(r) for r in conn.execute(
        "SELECT username, label, created_at FROM sessions WHERE kind = 'token' ORDER BY username, created_at")]


def prune(conn):
    """Toglie le sessioni scadute (job giornaliero)."""
    conn.execute("DELETE FROM sessions WHERE kind = 'session' AND expires_at < ?", (db.now_ms(),))
    conn.commit()


# --- Tentativi falliti (in memoria) ---------------------------------------------------

_failures = {}  # indirizzo → [istanti dei tentativi falliti]
_fail_lock = threading.Lock()


def blocked(addr, now=None):
    now = now or time.time()
    with _fail_lock:
        recent = [t for t in _failures.get(addr, []) if now - t < FAIL_WINDOW_S]
        _failures[addr] = recent
        return len(recent) >= MAX_FAILURES


def record_failure(addr, now=None):
    with _fail_lock:
        _failures.setdefault(addr, []).append(now or time.time())


def clear_failures(addr):
    with _fail_lock:
        _failures.pop(addr, None)
