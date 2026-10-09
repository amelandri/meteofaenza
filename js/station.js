// Dati osservati dalla centralina dell'Osservatorio Meteorologico "Evangelista Torricelli"
// di Faenza (www.meteofaenza.it). Li legge il server ogni 10 minuti (cron, vedi
// server/jobs.py) e li salva nel database: qui si chiede solo l'ultima misura al server,
// con le letture delle ultime 2 ore (rainLog) per capire se sta piovendo.

import { fetchStationData } from './api.js';

export const STATION = {
  name: 'Osservatorio Torricelli',
  fullName: 'Osservatorio Meteorologico "E. Torricelli" – Faenza',
  site: 'https://www.meteofaenza.it/',
};

// Oltre questa età la misura viene segnalata come non aggiornata.
export const STATION_STALE_MS = 30 * 60 * 1000;

// { time (istante della misura, ms), temperature, tMin, tMinTime, tMax, tMaxTime, humidity,
// pressure, windSpeed (km/h), windDirection (°), windMax, windMaxTime, rainToday (mm da
// mezzanotte), dewPoint, heatIndex, windChill, radiation, fetchedAt (lettura del server),
// rainLog: [{ t, day, mm }] }
export async function fetchStation() {
  const st = await fetchStationData();
  if (!st?.time || st.temperature == null) throw new Error('dati della centralina non validi');
  return st;
}
