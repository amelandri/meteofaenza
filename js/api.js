// Accesso alle API pubbliche di Open-Meteo (nessun backend proprio): previsioni dei
// modelli, ensemble e metadati dei run.

import { FORECAST_SCHEMA } from './storage.js';
import { localNowIso } from './weather.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const META_URL = 'https://api.open-meteo.com/data/{model}/static/meta.json';
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
// Ensemble usato per la probabilità di pioggia sui tragitti (stessa famiglia della
// precipitation_probability di Open-Meteo): 40 scenari orari.
export const ENSEMBLE_MODEL = { id: 'icon_eu_eps', name: 'ICON-EU-EPS' };

export const MODELS = [
  {
    key: 'i2i',
    id: 'italia_meteo_arpae_icon_2i',
    metaId: 'italia_meteo_arpae_icon_2i',
    name: 'ICON-2I',
    short: '2I',
    provider: 'ItaliaMeteo-ARPAE',
    resolution: '2,2 km',
    // lat min, lon min, lat max, lon max (dominio del modello)
    bbox: [33.7, 3.0, 48.9, 22.0],
  },
  {
    key: 'eu',
    id: 'icon_eu',
    metaId: 'dwd_icon_eu', // nome del dataset per i metadati del run
    name: 'ICON-EU',
    short: 'EU',
    provider: 'DWD',
    resolution: '7 km',
    bbox: [29.5, -23.5, 70.5, 62.5],
  },
];

export const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'pressure_msl',
  'is_day',
];

export const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'wind_gusts_10m_max',
];

// Dati "comuni", non attribuibili a un singolo modello, salvati una sola volta fuori da
// `models`: alba/tramonto (astronomici, identici per tutti) e probabilità di precipitazione.
// Quest'ultima Open-Meteo la ricava da modelli ensemble ed è restituita solo con il
// suffisso icon_eu (per ICON-2I è sempre null): va presentata come dato generale.
const COMMON_HOURLY = ['precipitation_probability'];
const COMMON_DAILY = ['sunrise', 'sunset'];

export function inModelDomain(model, lat, lon) {
  const [la0, lo0, la1, lo1] = model.bbox;
  return lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1;
}

// Oltre questo tempo una richiesta viene interrotta: con una rete mobile che non risponde
// il caricamento altrimenti resterebbe in corso per sempre (e bloccherebbe i successivi).
const TIMEOUT_MS = 20 * 1000;

// Errore con messaggio già in italiano, mostrato così com'è all'utente.
class ApiError extends Error {}

function httpReason(status, body) {
  if (status === 429) return 'troppe richieste, riprova tra qualche minuto';
  if (status >= 500) return `servizio non disponibile (HTTP ${status})`;
  return body?.reason ? `richiesta non valida (${body.reason})` : `errore HTTP ${status}`;
}

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* risposta non JSON */ }
      throw new ApiError(httpReason(res.status, body));
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('il server non risponde');
    // fetch() rifiuta con TypeError ("Failed to fetch", "Load failed") se la rete manca.
    if (err instanceof TypeError) throw new ApiError('connessione non riuscita');
    throw new ApiError('risposta non valida');
  } finally {
    clearTimeout(timer);
  }
}

// Precipitazione oraria di ogni scenario dell'ensemble, per calcolare la probabilità che
// piova durante un intervallo (quota di scenari con pioggia nell'intervallo). Restituisce
// { model, time: [...], members: [[mm per ora], ...], fetchedAt } oppure null se non disponibile.
async function fetchEnsemble(loc) {
  try {
    const params = new URLSearchParams({
      latitude: loc.lat.toFixed(4),
      longitude: loc.lon.toFixed(4),
      hourly: 'precipitation',
      models: ENSEMBLE_MODEL.id,
      forecast_days: '6', // come le previsioni: tragitti e dettaglio orario (ICON-EU-EPS arriva a ~5 giorni)
      past_days: '1', // come le previsioni (vedi fetchForecast)
      timezone: 'auto',
    });
    const data = await getJSON(`${ENSEMBLE_URL}?${params}`);
    const h = data.hourly;
    // Chiavi: "precipitation" (scenario di controllo) e "precipitation_memberNN". Con un
    // solo modello richiesto l'API non aggiunge il suffisso del modello; lo si accetta
    // comunque nel caso venga aggiunto.
    const key = new RegExp(`^precipitation(_member\\d+)?(_${ENSEMBLE_MODEL.id})?$`);
    const members = Object.keys(h).filter((k) => key.test(k)).map((k) => h[k]);
    return members.length ? { model: ENSEMBLE_MODEL.name, time: h.time, members, fetchedAt: Date.now() } : null;
  } catch {
    return null; // senza ensemble l'app ripiega sulla probabilità oraria (approssimata)
  }
}

// Un ensemble scaricato in precedenza si riusa se l'aggiornamento fallisce, ma non oltre
// questo tempo (ICON-EU-EPS esce ogni 6 ore).
const ENSEMBLE_REUSE_MS = 12 * 60 * 60 * 1000;

// Taglia le serie di un blocco (orario o giornaliero) all'intervallo [from, to).
function sliceBlock(block, vars, common, from, to) {
  block.time = block.time.slice(from, to);
  for (const v of common) block[v] = block[v].slice(from, to);
  for (const m of MODELS) {
    for (const v of vars) block.models[m.key][v] = block.models[m.key][v].slice(from, to);
  }
}

async function fetchModelRun(model) {
  try {
    const m = await getJSON(META_URL.replace('{model}', model.metaId));
    return {
      init: m.last_run_initialisation_time,
      available: m.last_run_availability_time,
      interval: m.update_interval_seconds, // ogni quanto il modello pubblica un nuovo run
    };
  } catch {
    return null; // i metadati sono accessori: non bloccano la previsione
  }
}

// Scarica le previsioni di entrambi i modelli e le normalizza in
// { hourly: { time, models: { i2i: {var: []}, eu: {...} } }, daily: {...}, runs, ... }
// `prev`: previsione precedente, da cui recuperare ensemble e metadati dei run se il loro
// download fallisce (il risultato è allora segnato `incomplete` e riscaricato prima).
export async function fetchForecast(loc, prev = null) {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    hourly: [...HOURLY_VARS, ...COMMON_HOURLY].join(','),
    daily: [...DAILY_VARS, ...COMMON_DAILY].join(','),
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: '6',
    // Anche il giorno prima, per avere l'ora 23 di ieri: dopo mezzanotte il grafico parte
    // dall'ora precedente. Il resto di ieri viene scartato subito sotto.
    past_days: '1',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });

  const [data, ensemble, ...runs] = await Promise.all([
    getJSON(`${FORECAST_URL}?${params}`),
    fetchEnsemble(loc),
    ...MODELS.map(fetchModelRun),
  ]);

  const pick = (block, vars) => {
    const models = {};
    for (const m of MODELS) {
      models[m.key] = {};
      for (const v of vars) models[m.key][v] = block[`${v}_${m.id}`] || [];
    }
    return { time: block.time, models };
  };

  // Prima serie che contiene almeno un valore (senza suffisso o di uno dei modelli).
  const common = (block, v) => [block[v], ...MODELS.map((m) => block[`${v}_${m.id}`])]
    .find((arr) => Array.isArray(arr) && arr.some((x) => x != null)) || [];

  const hourly = pick(data.hourly, HOURLY_VARS);
  const daily = pick(data.daily, DAILY_VARS);
  for (const v of COMMON_HOURLY) hourly[v] = common(data.hourly, v);
  for (const v of COMMON_DAILY) daily[v] = common(data.daily, v);

  // Taglia la coda oraria in cui nessun modello ha dati.
  let last = -1;
  for (const m of MODELS) {
    const t = hourly.models[m.key].temperature_2m;
    for (let i = t.length - 1; i > last; i--) if (t[i] != null) { last = i; break; }
  }
  // Di ieri si tiene solo l'ultima ora (23:00) per i dati orari, nulla per i giornalieri.
  const today = localNowIso(data.utc_offset_seconds).slice(0, 10);
  const firstToday = hourly.time.findIndex((t) => t >= today);
  const first = Math.max(0, firstToday - 1);
  sliceBlock(hourly, HOURLY_VARS, COMMON_HOURLY, first, last >= 0 ? last + 1 : undefined);
  const firstDay = daily.time.findIndex((t) => t >= today);
  if (firstDay > 0) sliceBlock(daily, DAILY_VARS, COMMON_DAILY, firstDay);

  if (ensemble) {
    const from = ensemble.time.indexOf(hourly.time[0]);
    if (from > 0) {
      ensemble.time = ensemble.time.slice(from);
      ensemble.members = ensemble.members.map((s) => s.slice(from));
    }
  }

  // Ensemble e metadati non riusciti: si tengono quelli della previsione precedente.
  const oldEnsemble = prev?.ensemble?.fetchedAt > Date.now() - ENSEMBLE_REUSE_MS ? prev.ensemble : null;
  const incomplete = !ensemble || runs.some((r) => !r);

  return {
    schema: FORECAST_SCHEMA,
    fetchedAt: Date.now(),
    incomplete,
    timezone: data.timezone,
    tzAbbr: data.timezone_abbreviation,
    utcOffset: data.utc_offset_seconds,
    gridElevation: data.elevation,
    hourly,
    daily,
    runs: Object.fromEntries(MODELS.map((m, i) => [m.key, runs[i] || prev?.runs?.[m.key] || null])),
    ensemble: ensemble || oldEnsemble,
  };
}
