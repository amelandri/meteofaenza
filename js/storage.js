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

// theme: "auto" (segue il sistema), "light" o "dark"; applicato da js/theme.js.
export const THEMES = ['auto', 'light', 'dark'];
// models: previsioni mostrate, "both" (entrambi i modelli), "i2i" o "eu" (vedi shownModels()
// in app.js). Non riguarda le probabilità di pioggia, sempre visibili.
export const MODEL_VIEWS = ['both', 'i2i', 'eu'];
// chartFrom: inizio del grafico "Andamento orario", "now" (ora precedente a quella attuale)
// o "today" (mezzanotte di oggi).
const DEFAULT_SETTINGS = { variable: 'rain', range: '72', chartFrom: 'now', showAllHours: false, hourlyOpen: false, radarOpen: false, riversOpen: false, theme: 'auto', models: 'both', verifyLead: 1, verifyDays: 7 };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });
export const saveSettings = (patch) => write(KEYS.settings, { ...getSettings(), ...patch });

// Valori ammessi di ogni preferenza: li usano la pagina
// Impostazioni (un pulsante per valore) e l'importazione (valori diversi scartati).
// variable = chiavi di VARIABLES in app.js, range / chartFrom = pulsanti del grafico in
// index.html, verifyLead / verifyDays = selettori di verify.html: se cambiano là, aggiornarli qui.
export const PREF_VALUES = {
  theme: THEMES,
  models: MODEL_VIEWS,
  variable: ['rain', 'temp', 'wind', 'cloud', 'humidity', 'pressure'],
  range: ['24', '72', 'all'],
  chartFrom: ['now', 'today'],
  showAllHours: [false, true],
  hourlyOpen: [false, true],
  radarOpen: [false, true],
  riversOpen: [false, true],
  verifyLead: [1, 2],
  verifyDays: [7, 30],
};
// Confronto stretto: un oggetto, un array o "true" al posto di true non passano.
export const validPref = (key, v) => Object.prototype.hasOwnProperty.call(PREF_VALUES, key) && PREF_VALUES[key].includes(v);

// --- Esportazione e importazione delle preferenze (pagina Impostazioni) -------------
// File JSON { app, kind, version, exportedAt, settings }. Il file importato è un dato non
// fidato: si legge solo con JSON.parse (mai eseguito), entro MAX_IMPORT_BYTES, e si tengono
// solo le chiavi di PREF_VALUES con un valore ammesso; il resto si scarta (watch, gli intervalli
// monitorati delle versioni precedenti, senza segnalarlo). Le preferenze si ricostruiscono
// in un oggetto nuovo, mai copiando quello del file.

export const SETTINGS_FILE = { app: 'meteo-faenza', kind: 'settings', version: 1 };
export const MAX_IMPORT_BYTES = 16 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function exportSettings() {
  const current = getSettings();
  const settings = {};
  for (const k of Object.keys(PREF_VALUES)) if (validPref(k, current[k])) settings[k] = current[k];
  return { ...SETTINGS_FILE, exportedAt: new Date().toISOString(), settings };
}

// Legge il testo di un file esportato: { settings, ignored } (chiavi scartate) o { error }.
export function parseSettingsFile(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) return { error: 'Il file è troppo grande per essere un file di impostazioni.' };
  let data;
  try {
    data = JSON.parse(text, (k, v) => (UNSAFE_KEYS.has(k) ? undefined : v));
  } catch {
    return { error: 'Il file non è un JSON valido.' };
  }
  if (!isObject(data) || data.app !== SETTINGS_FILE.app || data.kind !== SETTINGS_FILE.kind || !isObject(data.settings)) {
    return { error: 'Il file non contiene impostazioni di Meteo Faenza.' };
  }
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > SETTINGS_FILE.version) {
    return { error: 'Il file è di una versione dell\'app non supportata.' };
  }
  const src = data.settings;
  const settings = {};
  const ignored = [];
  for (const k of Object.keys(src)) {
    if (k === 'watch') continue; // intervalli monitorati: non più usati
    if (validPref(k, src[k])) settings[k] = src[k];
    else ignored.push(k);
  }
  return { settings, ignored };
}

// Salva le preferenze importate (già controllate) sopra quelle attuali.
export function importSettings(settings) {
  const patch = {};
  for (const k of Object.keys(PREF_VALUES)) if (own(settings, k) && validPref(k, settings[k])) patch[k] = settings[k];
  return saveSettings(patch);
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

// Uscita dall'app (o sessione scaduta): toglie le copie dei dati (previsioni, misura della
// centralina, medie), così senza accesso non restano consultabili offline. Le preferenze
// (meteo:settings) restano: non sono dati riservati.
export function clearData() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && k !== KEYS.settings) keys.push(k);
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
  if (saved && typeof saved === 'object' && 'watch' in saved) {
    delete saved.watch;
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
