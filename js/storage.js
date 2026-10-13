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
const DEFAULT_SETTINGS = { variable: 'rain', range: '72', chartFrom: 'now', showAllHours: false, hourlyOpen: false, radarOpen: false, riversOpen: false, theme: 'auto', models: 'both' };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });
export const saveSettings = (patch) => write(KEYS.settings, { ...getSettings(), ...patch });

// Valori ammessi delle altre preferenze (esportazione/importazione, vedi sotto): variable =
// chiavi di VARIABLES in app.js, range / chartFrom = pulsanti del grafico in index.html,
// verifyLead / verifyDays = selettori di verify.js. Se cambiano là, aggiornarli qui.
const CHART_VARIABLES = ['rain', 'temp', 'wind', 'cloud', 'humidity', 'pressure'];
const CHART_RANGES = ['24', '72', 'all'];
const CHART_FROM = ['now', 'today'];
const isBool = (v) => typeof v === 'boolean';
const oneOf = (list) => (v) => (typeof v === 'string' || typeof v === 'number') && list.includes(v);
// Preferenze esportabili (tranne watch, trattato a parte) con il controllo del valore.
const SETTING_RULES = {
  theme: oneOf(THEMES),
  models: oneOf(MODEL_VIEWS),
  variable: oneOf(CHART_VARIABLES),
  range: oneOf(CHART_RANGES),
  chartFrom: oneOf(CHART_FROM),
  showAllHours: isBool,
  hourlyOpen: isBool,
  radarOpen: isBool,
  riversOpen: isBool,
  verifyLead: oneOf([1, 2]),
  verifyDays: oneOf([7, 30]),
};

// --- Intervalli monitorati (pagina Impostazioni) ---------------------------------
// Gruppo di intervalli orari in cui l'app valuta se pioverà (oggi mostrati come tragitti
// in bici). Salvato in settings.watch come { label, windows: [{ from, to, days }] }: orari
// in ora locale (HH:MM), days = giorni della settimana in cui l'intervallo vale (0 = domenica …
// 6 = sabato, come parts().wd di weather.js). Così si possono anche definire orari diversi
// giorno per giorno (intervalli distinti su giorni diversi).

export const MAX_WATCH_WINDOWS = 6; // in tutto…
export const MAX_WATCH_PER_DAY = 4; // …e al massimo 4 nello stesso giorno (una riga di blocchi)
export const MAX_WATCH_LABEL = 24;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
// Predefinito: nessun intervallo (al loro posto "Prossimi giorni" mostra un invito discreto
// a definirli nelle Impostazioni).
export const DEFAULT_WATCH = { label: 'Bike', windows: [] };
// Intervalli predefiniti delle versioni precedenti: li ricevono, salvati una volta per
// tutte, gli utenti che già usavano l'app senza averli mai cambiati (vedi getWatch()).
const LEGACY_WATCH = {
  label: 'Bike',
  windows: [
    { from: '06:45', to: '08:00', days: [...ALL_DAYS] },
    { from: '12:30', to: '15:00', days: [...ALL_DAYS] },
    { from: '17:00', to: '18:30', days: [...ALL_DAYS] },
  ],
};

// Giorni validi, senza doppioni e ordinati; assenti (dati salvati prima dei giorni) o vuoti →
// tutti i giorni.
function normalizeDays(days) {
  const ok = Array.isArray(days) ? [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  return ok.length ? ok : [...ALL_DAYS];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Normalizza gli intervalli monitorati (letti dallo storage o dal modulo): etichetta non vuota,
// intervalli validi con inizio < fine e giorni (normalizeDays), ordinati per orario, al
// massimo MAX_WATCH_WINDOWS (anche nessuno). Sovrapposizioni e limite per giorno li
// controlla il modulo. Intervalli non validi vengono scartati.
// Nel nome si tolgono i caratteri di controllo e di formato (a capo, direzione del testo…).
// Gli orari devono essere stringhe: RegExp.test() converte, e ['07:00'] passerebbe il test.
const isHHMM = (v) => typeof v === 'string' && HHMM.test(v);
export function normalizeWatch(watch) {
  const label = typeof watch?.label === 'string' ? watch.label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_WATCH_LABEL) : '';
  const windows = (Array.isArray(watch?.windows) ? watch.windows : [])
    .filter((w) => isHHMM(w?.from) && isHHMM(w?.to) && w.from < w.to)
    .map((w) => ({ from: w.from, to: w.to, days: normalizeDays(w.days) }))
    .sort((a, b) => a.from.localeCompare(b.from))
    .slice(0, MAX_WATCH_WINDOWS);
  return { label: label || DEFAULT_WATCH.label, windows };
}

// L'app è già stata usata in questo browser (dati salvati dalle versioni precedenti)?
function hasPreviousData() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === KEYS.station || k?.startsWith(CACHE_PREFIX)) return true;
    }
  } catch { /* storage non accessibile */ }
  return false;
}

// settings.watch assente = mai salvato: chi usava già l'app teneva gli intervalli predefiniti
// di allora (LEGACY_WATCH) e li conserva; un nuovo utente parte senza intervalli. La scelta si
// salva subito, così non si ripete alle visite successive.
export function getWatch() {
  const saved = getSettings().watch;
  if (saved !== undefined) return normalizeWatch(saved);
  const watch = normalizeWatch(hasPreviousData() ? LEGACY_WATCH : DEFAULT_WATCH);
  saveSettings({ watch });
  return watch;
}
export const saveWatch = (watch) => saveSettings({ watch: normalizeWatch(watch) });
export const resetWatch = () => saveWatch(DEFAULT_WATCH);

// --- Esportazione e importazione delle preferenze (pagina Impostazioni) -------------
// File JSON { app, kind, version, exportedAt, settings }. Il file importato è un dato non
// fidato: si legge solo con JSON.parse (mai eseguito), entro MAX_IMPORT_BYTES, e si tengono
// solo le chiavi di SETTING_RULES con un valore ammesso, più watch (da controllare ancora con
// normalizeWatch() e le regole del modulo); il resto si scarta. Le preferenze si ricostruiscono
// in un oggetto nuovo, mai copiando quello del file.

export const SETTINGS_FILE = { app: 'meteo-faenza', kind: 'settings', version: 1 };
export const MAX_IMPORT_BYTES = 16 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function exportSettings() {
  const current = getSettings();
  const settings = {};
  for (const [k, ok] of Object.entries(SETTING_RULES)) if (ok(current[k])) settings[k] = current[k];
  settings.watch = getWatch();
  return { ...SETTINGS_FILE, exportedAt: new Date().toISOString(), settings };
}

// Legge il testo di un file esportato: { settings, ignored } (chiavi scartate) o { error }.
// settings.watch, se c'è, è ancora quello del file: lo controlla chi importa.
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
    if (k === 'watch') continue;
    if (own(SETTING_RULES, k) && SETTING_RULES[k](src[k])) settings[k] = src[k];
    else ignored.push(k);
  }
  if (own(src, 'watch')) {
    if (isObject(src.watch)) settings.watch = { label: src.watch.label, windows: src.watch.windows };
    else ignored.push('watch');
  }
  return { settings, ignored };
}

// Salva le preferenze importate (già controllate) sopra quelle attuali.
export function importSettings(settings) {
  const patch = {};
  for (const k of Object.keys(SETTING_RULES)) if (own(settings, k) && SETTING_RULES[k](settings[k])) patch[k] = settings[k];
  if (own(settings, 'watch')) patch.watch = normalizeWatch(settings.watch);
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

// Dati delle versioni precedenti, non più usati: preferiti, ultima località, indice della
// cache e previsioni salvate per località diverse da `keep`.
export function removeLegacyKeys(keep) {
  remove(`${PREFIX}favorites`);
  remove(`${PREFIX}lastLocation`);
  remove(`${PREFIX}cacheIndex`);
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
