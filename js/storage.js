// Persistenza nel localStorage del browser. Ogni accesso è protetto da try/catch:
// in navigazione privata o con storage pieno/bloccato l'app continua a funzionare.

const PREFIX = 'meteo:';
const KEYS = {
  settings: `${PREFIX}settings`,
  station: `${PREFIX}station`,
  cacheIndex: `${PREFIX}cacheIndex`,
};
const CACHE_PREFIX = `${PREFIX}fc:`;
const MAX_CACHED = 10;

// Dopo questo intervallo i dati in cache vengono riscaricati (se online).
export const CACHE_TTL_MS = 30 * 60 * 1000;

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

const DEFAULT_SETTINGS = { variable: 'rain', range: '72', showAllHours: false, hourlyOpen: false };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });
export const saveSettings = (patch) => write(KEYS.settings, { ...getSettings(), ...patch });

// --- Intervalli monitorati (pagina Impostazioni) ---------------------------------
// Gruppo di intervalli orari in cui l'app valuta se pioverà (oggi mostrati come tragitti
// in bici). Salvato in settings.watch come { label, windows: [{ from, to }] } (ora locale, HH:MM).

export const MAX_WATCH_WINDOWS = 3;
export const MAX_WATCH_LABEL = 24;
export const DEFAULT_WATCH = {
  label: 'Bike',
  windows: [
    { from: '06:45', to: '08:00' },
    { from: '12:30', to: '15:00' },
    { from: '17:00', to: '18:30' },
  ],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Normalizza gli intervalli monitorati (letti dallo storage o dal modulo): etichetta non vuota,
// intervalli validi con inizio < fine, ordinati, al massimo MAX_WATCH_WINDOWS.
// Ciò che non è valido torna al valore predefinito.
export function normalizeWatch(watch) {
  const label = typeof watch?.label === 'string' ? watch.label.trim().slice(0, MAX_WATCH_LABEL) : '';
  const windows = (Array.isArray(watch?.windows) ? watch.windows : [])
    .filter((w) => HHMM.test(w?.from) && HHMM.test(w?.to) && w.from < w.to)
    .map((w) => ({ from: w.from, to: w.to }))
    .sort((a, b) => a.from.localeCompare(b.from))
    .slice(0, MAX_WATCH_WINDOWS);
  return {
    label: label || DEFAULT_WATCH.label,
    windows: windows.length ? windows : DEFAULT_WATCH.windows.map((w) => ({ ...w })),
  };
}

export const getWatch = () => normalizeWatch(getSettings().watch);
export const saveWatch = (watch) => saveSettings({ watch: normalizeWatch(watch) });
export const resetWatch = () => {
  const { watch, ...rest } = getSettings();
  return write(KEYS.settings, rest);
};

// --- Ultima misura della centralina ---------------------------------------------

export const getStation = () => read(KEYS.station, null);
export const setStation = (data) => write(KEYS.station, data);

// --- Cache previsioni ----------------------------------------------------------

export function getCachedForecast(loc) {
  return read(CACHE_PREFIX + locationId(loc), null);
}

export function setCachedForecast(loc, forecast) {
  const id = locationId(loc);
  let index = read(KEYS.cacheIndex, []).filter((x) => x !== id);
  index.unshift(id);

  // Elimina le voci più vecchie oltre il limite.
  for (const old of index.slice(MAX_CACHED)) remove(CACHE_PREFIX + old);
  index = index.slice(0, MAX_CACHED);

  let ok = write(CACHE_PREFIX + id, forecast);
  // Storage pieno: libera spazio sacrificando le voci meno recenti e riprova.
  while (!ok && index.length > 1) {
    remove(CACHE_PREFIX + index.pop());
    ok = write(CACHE_PREFIX + id, forecast);
  }
  write(KEYS.cacheIndex, index);
  return ok;
}

export const isFresh = (forecast) => !!forecast && Date.now() - forecast.fetchedAt < CACHE_TTL_MS;

// --- Pulizia ----------------------------------------------------------------------

// Dati delle versioni con località selezionabile, non più usati: preferiti, ultima
// località e previsioni salvate per località diverse da `keep`.
export function removeLegacyKeys(keep) {
  remove(`${PREFIX}favorites`);
  remove(`${PREFIX}lastLocation`);
  const keepId = locationId(keep);
  const index = read(KEYS.cacheIndex, []);
  for (const id of index) if (id !== keepId) remove(CACHE_PREFIX + id);
  write(KEYS.cacheIndex, index.filter((id) => id === keepId));
}
