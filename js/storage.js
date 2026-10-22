// Persistenza nel localStorage del browser. Ogni accesso è protetto da try/catch:
// in navigazione privata o con storage pieno/bloccato l'app continua a funzionare.

const PREFIX = 'meteo:';
const KEYS = {
  settings: `${PREFIX}settings`,
  station: `${PREFIX}station`,
};
const CACHE_PREFIX = `${PREFIX}fc:`;

// Versione della forma dei dati prodotti da fetchForecast(): incrementarla quando cambia,
// così le previsioni salvate con la forma precedente vengono scartate e riscaricate.
export const FORECAST_SCHEMA = 4;

// Ogni quanto l'app ricontrolla il proprio server (se online). È il server a scaricare le
// fonti esterne appena escono nuovi run (cron): qui basta un controllo leggero, e grazie
// all'ETag il browser riscarica il JSON solo se è cambiato.
export const CACHE_TTL_MS = 10 * 60 * 1000;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignora */ }
}

export const locationId = (loc) => `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;

// --- Impostazioni ---------------------------------------------------------------
// Le preferenze sono salvate sul server, per utente (api/settings, server/prefs.py). Qui ne
// resta solo una copia di lettura (meteo:settings), aggiornata dal server, che serve a
// leggerle subito all'apertura (theme.js applica il tema prima del primo disegno) e offline;
// clearData() la cancella all'uscita.
// - saveSettings(): aggiorna subito la copia e mette la modifica in meteo:settings-pending;
//   syncSettings() la invia al server (anche più tardi, se si è offline).
// - syncSettings(): legge le preferenze dal server e riscrive la copia; se l'utente non ne ha
//   ancora e la copia è dei tempi in cui stavano solo nel browser (manca meteo:settings-sync),
//   le invia al server (importazione al primo accesso). A ogni cambio della copia invia
//   l'evento "meteo-settings" sulla finestra.

// theme: "auto" (segue il sistema), "light" o "dark"; applicato da js/theme.js.
export const THEMES = ['auto', 'light', 'dark'];
// models: previsioni mostrate, "both" (entrambi i modelli), "i2i" o "eu" (vedi shownModels()
// in app.js). Non riguarda le probabilità di pioggia, sempre visibili.
export const MODEL_VIEWS = ['both', 'i2i', 'eu'];
const DEFAULT_SETTINGS = { variable: 'rain', range: '72', showAllHours: false, hourlyOpen: false, radarOpen: false, riversOpen: false, theme: 'auto', models: 'both', verifyLead: 1, verifyDays: 7 };
const SYNC_KEY = `${PREFIX}settings-sync`;
const PENDING_KEY = `${PREFIX}settings-pending`;
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });

// Valori ammessi di ogni preferenza: li usano la pagina Impostazioni (un pulsante per valore) e
// il controllo di quanto si invia al server, che li ricontrolla (PREF_VALUES di
// server/prefs.py: devono restare uguali). variable = chiavi di VARIABLES in app.js, range =
// pulsanti del grafico in index.html, verifyLead / verifyDays = selettori di
// verify.html: se cambiano là, aggiornarli qui e sul server.
export const PREF_VALUES = {
  theme: THEMES,
  models: MODEL_VIEWS,
  variable: ['rain', 'temp', 'wind', 'cloud', 'humidity', 'pressure'],
  range: ['24', '72', 'all'],
  showAllHours: [false, true],
  hourlyOpen: [false, true],
  radarOpen: [false, true],
  riversOpen: [false, true],
  verifyLead: [1, 2],
  verifyDays: [7, 30, 60, 90],
};
// Confronto stretto: un oggetto, un array o "true" al posto di true non passano.
export const validPref = (key, v) => Object.prototype.hasOwnProperty.call(PREF_VALUES, key) && PREF_VALUES[key].includes(v);
const onlyValid = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => validPref(k, v)));

export function saveSettings(patch) {
  const p = onlyValid(patch);
  const ok = write(KEYS.settings, { ...read(KEYS.settings, {}), ...p });
  write(PENDING_KEY, { ...read(PENDING_KEY, {}), ...p });
  syncSettings();
  return ok;
}

// Una sincronizzazione alla volta, in ordine (le modifiche ravvicinate partono una dopo l'altra).
let chain = Promise.resolve(null);
export const syncSettings = () => (chain = chain.then(doSync, doSync));

const JSON_POST = { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };

async function doSync() {
  try {
    const res = await fetch('api/settings', { cache: 'no-store' });
    if (!res.ok) return null; // senza accesso (401) ci pensa getJSON() delle pagine
    let fresh = (await res.json()).settings;
    const pending = onlyValid(read(PENDING_KEY, {}));
    // Importazione al primo accesso: l'utente non ha preferenze sul server e la copia locale è
    // dei tempi in cui le preferenze stavano solo nel browser.
    const legacy = fresh === null && !read(SYNC_KEY, false) ? onlyValid(read(KEYS.settings, {})) : {};
    const patch = { ...legacy, ...pending };
    if (Object.keys(patch).length) {
      const r = await fetch('api/settings', { ...JSON_POST, body: JSON.stringify({ settings: patch }) });
      if (!r.ok) return null;
      fresh = (await r.json()).settings;
      // tolte dalle modifiche in sospeso quelle inviate (non quelle cambiate nel frattempo)
      const now = read(PENDING_KEY, {});
      for (const [k, v] of Object.entries(patch)) if (now[k] === v) delete now[k];
      if (Object.keys(now).length) write(PENDING_KEY, now);
      else remove(PENDING_KEY);
    }
    const before = JSON.stringify(getSettings());
    write(KEYS.settings, { ...(fresh || {}), ...onlyValid(read(PENDING_KEY, {})) });
    write(SYNC_KEY, true);
    const after = getSettings();
    if (JSON.stringify(after) !== before) window.dispatchEvent(new Event('meteo-settings'));
    return after;
  } catch {
    return null; // offline: la copia resta, le modifiche partono alla prossima occasione
  }
}

// --- Medie del periodo (climatologia, fetchNormals() di api.js) --------------------
// Copia locale di quelle del server (che le aggiorna una volta l'anno), in meteo:normals
// come { schema, id, fetchedAt (quando l'app le ha prese dal server), tmax: [366],
// tmin: [366] }. Si richiedono al server se mancano, sono di un'altra località o forma, o
// la copia ha più di 30 giorni (NORMALS_MAX_AGE_MS).
const NORMALS_KEY = `${PREFIX}normals`;
const NORMALS_SCHEMA = 1;
export const NORMALS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getNormals(loc) {
  const n = read(NORMALS_KEY, null);
  const ok = n?.schema === NORMALS_SCHEMA && n.id === locationId(loc)
    && Array.isArray(n.tmax) && n.tmax.length === 366 && Array.isArray(n.tmin) && n.tmin.length === 366;
  return ok ? n : null;
}
export const setNormals = (loc, normals) => write(NORMALS_KEY, { schema: NORMALS_SCHEMA, id: locationId(loc), fetchedAt: Date.now(), ...normals });
export const normalsDue = (n) => !n || Date.now() - n.fetchedAt > NORMALS_MAX_AGE_MS;

// --- Ultima misura della centralina ---------------------------------------------

export const getStation = () => read(KEYS.station, null);
export const setStation = (data) => write(KEYS.station, data);

// --- Cache previsioni ----------------------------------------------------------

// Previsioni più vecchie di così non vengono più mostrate né tenute nello storage.
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const isExpired = (forecast) => Date.now() - forecast.fetchedAt > MAX_AGE_MS;

// Previsione salvata, oppure null se manca, ha una forma diversa da quella attuale o è
// più vecchia di MAX_AGE_MS (in questi ultimi due casi viene anche eliminata).
export function getCachedForecast(loc) {
  const key = CACHE_PREFIX + locationId(loc);
  const f = read(key, null);
  if (!f) return null;
  if (f.schema === FORECAST_SCHEMA && Array.isArray(f.hourly?.time) && Array.isArray(f.daily?.time) && !isExpired(f)) return f;
  remove(key);
  return null;
}

export function setCachedForecast(loc, forecast) {
  const key = CACHE_PREFIX + locationId(loc);
  if (write(key, forecast)) return true;
  // Storage pieno: la copia precedente occupa ancora spazio fino alla sostituzione.
  remove(key);
  return write(key, forecast);
}

// Prossimo controllo del server: CACHE_TTL_MS dopo l'ultimo (checkedAt; nelle cache delle
// versioni precedenti manca e si usa fetchedAt).
export const nextDownloadAt = (forecast) => (forecast.checkedAt ?? forecast.fetchedAt) + CACHE_TTL_MS;

export const isFresh = (forecast) => !!forecast && Date.now() < nextDownloadAt(forecast);

// --- Pulizia ----------------------------------------------------------------------

// Uscita dall'app (o sessione scaduta): toglie tutte le copie (previsioni, misura della
// centralina, medie e preferenze, che stanno sul server), così senza accesso non resta niente
// consultabile offline.
export function clearData() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach(remove);
  } catch { /* storage non accessibile */ }
}

// Dati delle versioni precedenti, non più usati: preferiti, ultima località, indice della
// cache, previsioni salvate per località diverse da `keep` e intervalli monitorati
// (settings.watch).
export function removeLegacyKeys(keep) {
  remove(`${PREFIX}favorites`);
  remove(`${PREFIX}lastLocation`);
  remove(`${PREFIX}cacheIndex`);
  const saved = read(KEYS.settings, null);
  // preferenze tolte: watch (intervalli monitorati), chartFrom (inizio del grafico da 00:00)
  if (saved && typeof saved === 'object' && ('watch' in saved || 'chartFrom' in saved)) {
    delete saved.watch;
    delete saved.chartFrom;
    write(KEYS.settings, saved);
  }
  const keepKey = CACHE_PREFIX + locationId(keep);
  try {
    const old = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX) && k !== keepKey) old.push(k);
    }
    old.forEach(remove);
  } catch { /* storage non accessibile */ }
}
