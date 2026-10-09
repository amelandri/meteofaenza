// Accesso ai dati: il frontend legge solo dal proprio server (api/…, percorsi relativi così
// l'app funziona anche in una sottocartella). È il server a scaricare le fonti esterne
// (Open-Meteo, centralina) via cron e a salvarle nel database: vedi server/.

const API = {
  forecast: 'api/forecast',
  station: 'api/station',
  normals: 'api/normals',
};

export const MODELS = [
  {
    key: 'i2i',
    id: 'italia_meteo_arpae_icon_2i',
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
    name: 'ICON-EU',
    short: 'EU',
    provider: 'DWD',
    resolution: '7 km',
    bbox: [29.5, -23.5, 70.5, 62.5],
  },
];

export function inModelDomain(model, lat, lon) {
  const [la0, lo0, la1, lo1] = model.bbox;
  return lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1;
}

// Medie del periodo (calcolate dal server, vedi server/sources.py): trentennio 1991–2020,
// reanalisi ERA5-Land, media mobile di ±7 giorni. Qui solo per le etichette.
export const NORMALS = { name: 'ERA5-Land', from: 1991, to: 2020 };

// Posizione di una data "MM-DD" nell'anno bisestile di riferimento (0 = 1 gennaio … 365),
// come day_of_year() del server: indice delle medie del periodo.
export const dayOfYear = (mmdd) => Math.round((Date.UTC(2000, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3, 5))) - Date.UTC(2000, 0, 1)) / 864e5);

// Oltre questo tempo una richiesta viene interrotta: con una rete mobile che non risponde
// il caricamento altrimenti resterebbe in corso per sempre (e bloccherebbe i successivi).
const TIMEOUT_MS = 20 * 1000;

// Errore con messaggio già in italiano, mostrato così com'è all'utente.
class ApiError extends Error {}

function httpReason(status, body) {
  if (body?.error) return body.error; // messaggio del nostro server (es. dati non ancora disponibili)
  if (status >= 500) return `servizio non disponibile (HTTP ${status})`;
  return `errore HTTP ${status}`;
}

// Le risposte del server hanno un ETag e Cache-Control: no-cache: il browser rivalida e,
// se i dati non sono cambiati, riceve 304 e usa la copia che ha già (niente download).
export async function getJSON(url) {
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

// Previsioni dei due modelli, ensemble e metadati dei run, già normalizzati dal server:
// { schema, fetchedAt, incomplete, timezone, tzAbbr, utcOffset, hourly: { time, models:
// { i2i: {var: []}, eu }, precipitation_probability }, daily, runs, ensemble }.
// fetchedAt = quando il server le ha scaricate dalla fonte.
export const fetchForecast = () => getJSON(API.forecast);

// Medie del periodo: { tmax: [366], tmin: [366] } (°C), indicizzate con dayOfYear().
export async function fetchNormals() {
  const n = await getJSON(API.normals);
  if (!Array.isArray(n?.tmax) || n.tmax.length !== 366) throw new ApiError('medie del periodo non valide');
  return { tmax: n.tmax, tmin: n.tmin };
}

// Ultima misura della centralina con le letture delle ultime 2 ore (rainLog).
export const fetchStationData = () => getJSON(API.station);
