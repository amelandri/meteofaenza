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

const DEFAULT_SETTINGS = { variable: 'temp', range: '72', showAllHours: false, hourlyOpen: false };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) });
export const saveSettings = (patch) => write(KEYS.settings, { ...getSettings(), ...patch });

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
