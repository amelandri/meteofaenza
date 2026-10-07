// Dati osservati dalla centralina dell'Osservatorio Meteorologico "Evangelista Torricelli"
// di Faenza (www.meteofaenza.it), aggiornati circa ogni minuto.
//
// Il file non ha intestazioni CORS, quindi non è leggibile con fetch(): viene caricato con
// un tag <script> (che non richiede CORS) e definisce variabili globali stringa, es.
//   var temperature = '17.2';
// NB: in questo modo il codice del file viene eseguito nella pagina.

const STATION_URL = 'https://www.meteofaenza.it/dati/today/data.js';

export const STATION = {
  name: 'Osservatorio Torricelli',
  fullName: 'Osservatorio Meteorologico "E. Torricelli" – Faenza',
  site: 'https://www.meteofaenza.it/',
};

// Oltre questa età la misura viene segnalata come non aggiornata.
export const STATION_STALE_MS = 30 * 60 * 1000;

const num = (v) => (v == null || String(v).trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const hhmm = (v) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null);

function parse(w) {
  const time = num(w.currentTimeMillis);
  const temperature = num(w.temperature);
  if (!time || temperature == null) throw new Error('dati non validi');
  return {
    time, // istante della misura (ms)
    temperature,
    tMin: num(w.temperatureMin), tMinTime: hhmm(w.temperatureMinTime),
    tMax: num(w.temperatureMax), tMaxTime: hhmm(w.temperatureMaxTime),
    humidity: num(w.humidity),
    pressure: num(w.pressure),
    windSpeed: num(w.windSpeed), // km/h
    windDirection: num(w.windDirection), // gradi, provenienza
    windMax: num(w.windSpeedMax), windMaxTime: hhmm(w.windSpeedMaxTime),
    rainToday: num(w.rainfall), // mm da mezzanotte
    dewPoint: num(w.dewPoint),
    heatIndex: num(w.heatIndex),
    windChill: num(w.windChill),
    radiation: num(w.radiation), // W/m²
    fetchedAt: Date.now(),
  };
}

export function fetchStation({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${STATION_URL}?t=${Date.now()}`; // evita la cache HTTP
    script.async = true;
    let timer;
    const done = (fn) => { clearTimeout(timer); script.remove(); fn(); };
    timer = setTimeout(() => done(() => reject(new Error('tempo scaduto'))), timeout);
    script.onload = () => done(() => {
      try { resolve(parse(window)); } catch (err) { reject(err); }
    });
    script.onerror = () => done(() => reject(new Error('centralina non raggiungibile')));
    document.head.appendChild(script);
  });
}
