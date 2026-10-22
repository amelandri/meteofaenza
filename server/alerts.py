"""Allerte meteo per Faenza (Allerta Meteo Emilia-Romagna: ARPAE e Protezione Civile regionale).

Faenza è nella zona di allerta B1 "Bassa collina e pianura romagnola". Il portale Allerta
Meteo (API non documentata, la stessa dei livelli dei fiumi) dà il colore di ogni zona per
ogni fenomeno, per oggi e per domani; il feed Atom dei bollettini dà numero, validità, testo e
PDF di ogni allerta / bollettino di vigilanza. Conta solo la tabella per zona: il testo del
feed elenca le province, e una provincia (RA, FC) comprende anche zone di montagna e collina
con allerte che a Faenza non ci sono (es. allerte 101 e 102 del 2026: vento giallo "in
provincia di RA e FC", B1 tutta verde).

Il job (ogni 15 minuti, vedi deploy/crontab) salva un giorno per riga in alert_days (storico
come la centralina) e il feed nello snapshot 'alerts'. compose() dà il riepilogo di oggi e
domani, servito con la misura della centralina (api/station, campo alerts).
"""

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import config, db, sources

ZONE = 'B1'
ZONE_NAME = 'Bassa collina e pianura romagnola'
STATE_URL = f'{sources.ALLERTA_API}/get-stato-allerta'          # oggi
STATE_NEXT_URL = f'{sources.ALLERTA_API}/get-stato-allerta-domani'
FEED_URL = 'https://allertameteo.regione.emilia-romagna.it/o/compila-allerta-portlet/feed?feed=allerte-bollettini'

# Fenomeni nell'ordine dei bollettini, con i nomi usati dalla Regione. Stato del mare e
# mareggiate riguardano solo le zone costiere (per B1 il portale dà "white").
EVENTS = [
    ('idraulica', 'Piene dei fiumi'),
    ('idrogeologica', 'Frane e piene dei corsi minori'),
    ('temporali', 'Temporali'),
    ('vento', 'Vento'),
    ('temperature-estreme', 'Temperature estreme'),
    ('neve', 'Neve'),
    ('ghiaccio-pioggia-gela', 'Pioggia che gela'),
    ('stato-mare', 'Stato del mare'),
    ('mareggiate', 'Mareggiate'),
]
EVENT_NAMES = dict(EVENTS)
LEVELS = {'green': 0, 'yellow': 1, 'orange': 2, 'red': 3}  # 'white' = non previsto per la zona

# Dopo mezzanotte il portale potrebbe mostrare per qualche minuto come "oggi" l'allerta di
# ieri: in questa finestra il job non salva nulla (resta quella di oggi, salvata ieri come "domani").
MIDNIGHT_GUARD_MIN = 30

ATOM = '{http://www.w3.org/2005/Atom}'


def _tz():
    return ZoneInfo(config.TIMEZONE)


def parse_state(data):
    """Livelli della zona ZONE dalla risposta di get-stato-allerta: {fenomeno: 0…3}, o None
    se la zona manca. Formato: [{"area": "B1", "eventi": "idraulica:green,vento:yellow,…"}]."""
    if not isinstance(data, list):
        raise sources.SourceError('allerte: risposta non valida')
    for row in data:
        if isinstance(row, dict) and row.get('area') == ZONE:
            out = {}
            for part in str(row.get('eventi') or '').split(','):
                key, _, color = part.strip().partition(':')
                if key in EVENT_NAMES and color in LEVELS:
                    out[key] = LEVELS[color]
            return out or None
    return None


def parse_feed(xml_bytes):
    """Voci del feed: [{kind, number, start ('YYYY-MM-DD'), issuedAt (ms), title, text, pdf}],
    dalla più recente. kind = 'allerta' o 'vigilanza'."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as err:
        raise sources.SourceError('allerte: feed non valido') from err
    out = []
    for e in root.iter(f'{ATOM}entry'):
        title = (e.findtext(f'{ATOM}title') or '').strip()
        m = re.search(r'del (\d{2})/(\d{2})/(\d{4})', title)
        if not m:
            continue
        link = e.find(f'{ATOM}link')
        updated = (e.findtext(f'{ATOM}updated') or '').strip()
        try:
            issued = int(datetime.fromisoformat(updated.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError:
            issued = None
        num = re.search(r'(\d+/\d{4})', title)
        out.append({
            'kind': 'allerta' if title.lower().startswith('allerta') else 'vigilanza',
            'number': num.group(1) if num else None,
            'start': f'{m.group(3)}-{m.group(2)}-{m.group(1)}',
            'issuedAt': issued,
            'title': title,
            'text': clean_text(e.findtext(f'{ATOM}summary') or ''),
            'pdf': link.get('href') if link is not None else None,
        })
    out.sort(key=lambda x: x['issuedAt'] or 0, reverse=True)
    return out


def clean_text(s):
    """Descrizione dei fenomeni senza il primo paragrafo delle allerte ("Allerta +++GIALLA+++
    per … nelle province di …"): parla di province, non della zona di Faenza."""
    paras = [p.strip() for p in re.split(r'\n\s*\n', s.replace('\r', '')) if p.strip()]
    if len(paras) > 1 and paras[0].startswith('Allerta'):
        paras = paras[1:]
    return '\n'.join(p.replace('+++', '') for p in paras)


def run(conn, force=False):
    now = datetime.now(_tz())
    if not force and now.hour == 0 and now.minute < MIDNIGHT_GUARD_MIN:
        return 'subito dopo mezzanotte: salto'
    today = now.date()
    tomorrow = today + timedelta(days=1)
    feed = parse_feed(sources._get(FEED_URL))
    db.put_snapshot(conn, 'alerts', {'feed': feed})
    saved = []
    levels = parse_state(sources.get_json(STATE_URL))
    if levels:
        _put_day(conn, today.isoformat(), levels)
        saved.append('oggi')
    # Domani solo se il bollettino per domani è già uscito (di solito verso le 13:30): prima
    # il portale potrebbe mostrare ancora quello di oggi.
    if any(x['start'] == tomorrow.isoformat() for x in feed):
        levels = parse_state(sources.get_json(STATE_NEXT_URL))
        if levels:
            _put_day(conn, tomorrow.isoformat(), levels)
            saved.append('domani')
    conn.commit()
    return f'zona {ZONE}: ' + (', '.join(saved) or 'nessun dato') + f'; {len(feed)} bollettini nel feed'


def _put_day(conn, day, levels):
    conn.execute(
        'INSERT INTO alert_days (day, fetched_at, data) VALUES (?, ?, ?) '
        'ON CONFLICT(day) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
        (day, db.now_ms(), json.dumps(levels, separators=(',', ':'))))


def compose(conn, now_ms=None):
    """Oggi e domani per api/station: {zone, zoneName, days: [{day, level, fetchedAt,
    events: [{key, name, level}], bulletin: {kind, number, issuedAt, text, pdf} | None}]},
    o None se non c'è nulla. level = il più alto tra i fenomeni (0 = nessuna allerta)."""
    now = datetime.fromtimestamp((now_ms or db.now_ms()) / 1000, _tz()).date()
    days = [now.isoformat(), (now + timedelta(days=1)).isoformat()]
    rows = {r['day']: r for r in conn.execute(
        'SELECT day, fetched_at, data FROM alert_days WHERE day IN (?, ?)', days)}
    if not rows:
        return None
    feed = (db.get_snapshot(conn, 'alerts') or {}).get('data', {}).get('feed', [])
    out = []
    for day in days:
        r = rows.get(day)
        if not r:
            continue
        levels = json.loads(r['data'])
        events = [{'key': k, 'name': n, 'level': levels[k]} for k, n in EVENTS if k in levels]
        b = next((x for x in feed if x['start'] == day), None)
        out.append({
            'day': day, 'fetchedAt': r['fetched_at'],
            'level': max((e['level'] for e in events), default=0), 'events': events,
            'bulletin': {k: b[k] for k in ('kind', 'number', 'issuedAt', 'text', 'pdf')} if b else None,
        })
    return {'zone': ZONE, 'zoneName': ZONE_NAME, 'days': out}

