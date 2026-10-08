import { MODELS, fetchForecast, inModelDomain } from './api.js';
import { fetchStation, STATION, STATION_STALE_MS } from './station.js';
import * as store from './storage.js';
import { renderChart, tipValue } from './chart.js';
import {
  icon, describe, fmt, fmtSigned, windDir, windArrow, hourLabel, dayShort, dayRelative,
  localNowIso, localDateTime, fmtAgo, esc, sunEventIcon, dayTitle,
} from './weather.js';

const $ = (sel) => document.querySelector(sel);

const VARIABLES = {
  // L'ordine è quello dei tab: Precipitazioni per prima
  rain: {
    label: 'Precipitazioni', unit: 'mm', decimals: 1, yFloor: 0, minSpan: 2, type: 'bar',
    series: [{ v: 'precipitation' }],
    pop: true, // anche la probabilità di pioggia (scala a destra)
  },
  temp: {
    label: 'Temperatura', unit: '°C', decimals: 1, minSpan: 4,
    series: [{ v: 'temperature_2m' }],
  },
  wind: {
    label: 'Vento', unit: 'km/h', decimals: 0, yFloor: 0, minSpan: 10,
    series: [{ v: 'wind_speed_10m' }, { v: 'wind_gusts_10m', dash: true, label: 'raffiche' }],
  },
  cloud: {
    label: 'Nuvolosità', unit: '%', decimals: 0, yFloor: 0, yCeil: 100,
    series: [{ v: 'cloud_cover' }],
  },
  humidity: {
    label: 'Umidità', unit: '%', decimals: 0, yFloor: 0, yCeil: 100,
    series: [{ v: 'relative_humidity_2m' }],
  },
  pressure: {
    label: 'Pressione', unit: 'hPa', decimals: 0, minSpan: 6,
    series: [{ v: 'pressure_msl' }],
  },
};

// Località fissa: l'app mostra solo le previsioni di Faenza.
const LOCATION = {
  name: 'Faenza',
  admin: 'Ravenna, Emilia-Romagna',
  country: 'Italia',
  lat: 44.29007,
  lon: 11.87948,
  elevation: 35,
};

const state = {
  loc: LOCATION,
  data: null,
  settings: store.getSettings(),
  loading: false,
  station: store.getStation(), // ultima misura della centralina (anche da cache)
  stationLoading: false,
};

// La misura della centralina si aggiorna solo ai minuti 0, 10, 20, 30, 40, 50 (più un
// piccolo ritardo: il file viene pubblicato qualche secondo dopo lo scoccare del minuto).
const STATION_SLOT_MS = 10 * 60 * 1000;
const STATION_SLOT_DELAY_MS = 15 * 1000;

// --- Avvio -----------------------------------------------------------------------

function init() {
  buildVarTabs();
  bindControls();
  registerServiceWorker();
  store.removeLegacyKeys(LOCATION);

  window.addEventListener('online', () => { setBanner(null); if (!store.isFresh(state.data)) load(); if (stationMissedSlot()) loadStation(); });
  window.addEventListener('offline', () => setBanner('Sei offline: vengono mostrate le ultime previsioni salvate.'));
  if (!navigator.onLine) setBanner('Sei offline: vengono mostrate le ultime previsioni salvate.');

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderChartSection(); if (state.data) fitBikes(); }, 150);
  });

  // Aggiorna i dati quando l'app torna in primo piano dopo un po' di tempo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      if (!store.isFresh(state.data)) load();
      if (stationMissedSlot()) loadStation();
    }
  });

  load();
  if (stationMissedSlot()) loadStation();
  scheduleStation();
}

// --- Caricamento dati ------------------------------------------------------------

async function load({ force = false } = {}) {
  const loc = state.loc;
  const cached = store.getCachedForecast(loc);
  if (cached) {
    state.data = cached;
    render();
  } else if (!state.data) {
    showStatus('Caricamento delle previsioni…');
  }
  // Le cache salvate da versioni precedenti senza alba/tramonto o probabilità vengono riscaricate.
  if (!force && store.isFresh(cached) && cached.daily.sunrise && cached.hourly.precipitation_probability && 'ensemble' in cached) return;
  if (!navigator.onLine) {
    if (!cached) showStatus('Sei offline e non ci sono previsioni salvate.', { retry: true });
    return;
  }

  setLoading(true);
  try {
    const data = await fetchForecast(loc);
    state.data = data;
    if (!store.setCachedForecast(loc, data)) toast('Spazio locale esaurito: previsioni non salvate offline.');
    render();
  } catch (err) {
    if (cached) toast(`Aggiornamento non riuscito (${err.message}). Dati salvati ${fmtAgo(cached.fetchedAt)}.`);
    else showStatus(`Impossibile scaricare le previsioni: ${err.message}`, { retry: true });
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  state.loading = on;
  $('#refresh-btn').classList.toggle('spinning', on);
  if (state.data) renderHeader();
  $('#refresh-btn').disabled = on;
  document.body.classList.toggle('loading', on && !state.data);
}

// --- Rendering ---------------------------------------------------------------------

// Messaggio a tutta pagina quando non ci sono previsioni da mostrare (primo avvio, errori).
function showStatus(msg, { retry = false } = {}) {
  $('#status-msg').textContent = msg;
  $('#retry-btn').hidden = !retry;
  $('#status').hidden = false;
  $('#forecast').hidden = true;
}

function render() {
  const { loc, data } = state;
  if (!loc || !data) return;
  $('#status').hidden = true;
  $('#forecast').hidden = false;

  renderHeader();
  renderNow();
  renderDaily();
  renderChartSection();
  renderHourlyTable();
}

function availability(key) {
  const t = state.data.hourly.models[key].temperature_2m;
  let last = -1;
  for (let i = t.length - 1; i >= 0; i--) if (t[i] != null) { last = i; break; }
  return last;
}

function renderHeader() {
  const { loc, data } = state;
  const coords = `${fmt(loc.lat, 1).replace(',', '.')}°${loc.lat >= 0 ? 'N' : 'S'} ${fmt(Math.abs(loc.lon), 1).replace(',', '.')}°${loc.lon >= 0 ? 'E' : 'O'}`;
  const elev = loc.elevation != null ? ` · ${fmt(loc.elevation)} m` : '';
  // Su schermi stretti coordinate e quota vengono nascoste (.coords).
  $('#loc-sub').innerHTML = `${esc([loc.admin, loc.country].filter(Boolean).join(', '))}<span class="coords"> · ${coords}${elev}</span>`;

  // Tutti gli orari sono espressi nell'ora locale della località, non del dispositivo.
  const today = localNowIso(data.utcOffset).slice(0, 10);
  const at = (ms) => {
    const t = localDateTime(ms, data.timezone, data.utcOffset);
    return t.date === today ? t.time : `${t.day} ${t.time}`;
  };
  // Prossimo run atteso: ultima disponibilità + intervallo di pubblicazione del modello (stima).
  const nextRun = (r) => {
    if (!r?.available || !r.interval) return '';
    const ms = (r.available + r.interval) * 1000;
    return ms > Date.now() ? ` · prossimo ~${at(ms)}` : ' · nuovo run in arrivo';
  };
  const runs = MODELS.map((m) => {
    const r = data.runs?.[m.key];
    return `<span class="run"><i class="dot-${m.key}"></i>${m.name}: run delle ${r ? at(r.init * 1000) : 'n.d.'}${nextRun(r)}</span>`;
  }).join('');

  // Prossimo download dei dati da parte dell'app (scadenza della cache locale).
  const due = data.fetchedAt + store.CACHE_TTL_MS;
  let next;
  if (!navigator.onLine) next = 'prossimo appena torni online';
  else if (state.loading) next = 'aggiornamento in corso…';
  else next = due > Date.now() ? `prossimo alle ${at(due)}` : 'prossimo a breve';

  $('#updated').innerHTML = `<span>Aggiornato alle ${at(data.fetchedAt)} (${fmtAgo(data.fetchedAt)}) · ${next}</span>`
    + `<span>Orari locali di ${esc(loc.name)} (${esc(data.tzAbbr || data.timezone || '')})</span>${runs}`;
}

function nowIndex() {
  const now = localNowIso(state.data.utcOffset);
  const idx = state.data.hourly.time.indexOf(now);
  return idx;
}

// --- Centralina meteo -------------------------------------------------------------

async function loadStation() {
  if (state.stationLoading || !navigator.onLine) return;
  state.stationLoading = true;
  try {
    state.station = await fetchStation();
    store.setStation(state.station);
  } catch {
    // resta l'ultima misura salvata (se c'è), segnalata come non aggiornata se vecchia
  } finally {
    state.stationLoading = false;
    if (state.data) renderNow();
  }
}

function stationIsFresh() {
  return !!state.station && Date.now() - state.station.time < STATION_STALE_MS;
}

// Ultimo istante di lettura programmata (:00, :10, … + ritardo) e il successivo.
function lastStationSlot(now = Date.now()) {
  return Math.floor((now - STATION_SLOT_DELAY_MS) / STATION_SLOT_MS) * STATION_SLOT_MS + STATION_SLOT_DELAY_MS;
}
const nextStationSlot = () => lastStationSlot() + STATION_SLOT_MS;

// Vero se l'ultima lettura è precedente all'ultimo orario programmato: succede all'avvio o
// quando l'app era in background al momento della lettura (si recupera subito).
const stationMissedSlot = () => !state.station || state.station.fetchedAt < lastStationSlot();

// Programma la prossima lettura all'orario esatto. Con l'app in background la lettura
// viene saltata e recuperata al ritorno in primo piano (stationMissedSlot).
function scheduleStation() {
  clearTimeout(state.stationTimer);
  state.stationTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') loadStation();
    scheduleStation();
  }, Math.max(1000, nextStationSlot() - Date.now()));
}

// Riga "Misurato" del box Adesso: dati reali della centralina.
function renderObservation() {
  const st = state.station;
  if (!st) return '';
  const { timezone, utcOffset } = state.data;
  const today = localNowIso(utcOffset).slice(0, 10);
  const lt = localDateTime(st.time, timezone, utcOffset);
  const when = lt.date === today ? lt.time : `${lt.day} ${lt.time}`;
  const stale = !stationIsFresh();
  const sameDay = lt.date === today;
  const minmax = sameDay && st.tMin != null && st.tMax != null
    ? `min ${fmt(st.tMin, 1)}°${st.tMinTime ? ` (${st.tMinTime})` : ''} · max ${fmt(st.tMax, 1)}°${st.tMaxTime ? ` (${st.tMaxTime})` : ''}`
    : '';
  const stat = (label, value) => (value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '');
  return `<div class="day obs-row">
    <div class="day-name"><b class="now-hour">${when}</b><span class="muted small">Misurato${stale ? ' · <span class="obs-stale">non aggiornato</span>' : ''}</span><span class="muted small">prossima lettura ${localDateTime(nextStationSlot() - STATION_SLOT_DELAY_MS, timezone, utcOffset).time}</span></div>
    <article class="obs-card">
      <header><span class="obs-tag">Centralina</span><a class="muted small" href="${STATION.site}" target="_blank" rel="noopener" title="${esc(STATION.fullName)}">${esc(STATION.name)}</a></header>
      <div class="obs-body">
        <div class="obs-main">
          <div class="now-temp">${fmt(st.temperature, 1)}<span>°C</span></div>
          ${minmax ? `<div class="now-desc">${minmax}</div>` : ''}
        </div>
        <dl class="now-stats obs-stats">
          ${stat('Umidità', st.humidity != null ? `${fmt(st.humidity)}%` : '')}
          ${stat('Vento', st.windSpeed != null ? `${windArrow(st.windDirection)} ${fmt(st.windSpeed)} <small>${windDir(st.windDirection)}</small>` : '')}
          ${stat('Pioggia oggi', st.rainToday != null && sameDay ? `${fmt(st.rainToday, 1)} mm` : '')}
          ${stat('Raffica max', st.windMax != null && sameDay ? `${fmt(st.windMax)} km/h${st.windMaxTime ? ` <small>${st.windMaxTime}</small>` : ''}` : '')}
        </dl>
      </div>
    </article>
  </div>`;
}

// Box "Adesso": solo la lettura della centralina (nessuna previsione per l'ora corrente).
function renderNow() {
  $('#now').innerHTML = renderObservation()
    || `<p class="muted">Dati della centralina non disponibili${navigator.onLine ? '' : ' offline'}.</p>`;
}

// Valuta quanto i due modelli concordano su una giornata. Ogni criterio aggiunge punti di
// disaccordo e un motivo leggibile (mostrato nel tooltip dell'etichetta):
//   0 punti → concordi · 1 → lievi differenze · 2 o più → discordi.
// Le soglie sono euristiche (non uno standard meteorologico): vedi AGREE.
const AGREE = {
  tempMild: 1.5, // °C di differenza su massima o minima → 1 punto
  tempStrong: 3, // °C → 2 punti
  slotWet: 1, // mm in una fascia di 6 h: "piove"
  slotDry: 0.3, // mm in una fascia di 6 h: "asciutto" (tra le due soglie: non si giudica)
  rainRatio: 2, // se piove per entrambi: uno ne prevede almeno il doppio…
  rainAbs: 3, // …e la differenza è di almeno 3 mm → 1 punto
  gustDiff: 15, // km/h di differenza sulle raffiche…
  gustMin: 30, // …quando almeno un modello supera questa soglia → 1 punto
};
const isThunder = (code) => code != null && code >= 95;

function agreement(a, b) {
  if (a.tmax == null || b.tmax == null) return null;
  const [na, nb] = MODELS.map((m) => m.name); // a = ICON-2I, b = ICON-EU
  const issues = []; // { points, text }
  const ok = []; // aspetti in cui concordano (per il tooltip)

  // 1. Temperature: la differenza maggiore tra massime e minime.
  const dMax = Math.abs(a.tmax - b.tmax), dMin = Math.abs(a.tmin - b.tmin);
  const dT = Math.max(dMax, dMin);
  const which = dMax >= dMin
    ? `massima ${fmt(a.tmax)}° vs ${fmt(b.tmax)}°`
    : `minima ${fmt(a.tmin)}° vs ${fmt(b.tmin)}°`;
  if (dT >= AGREE.tempStrong) issues.push({ points: 2, text: `Temperature molto diverse: ${which}` });
  else if (dT >= AGREE.tempMild) issues.push({ points: 1, text: `Temperature diverse: ${which}` });
  else ok.push(`temperature entro ${fmt(AGREE.tempMild, 1)}°`);

  // 2. Quando piove: fascia per fascia, solo dove entrambi i modelli hanno dati.
  const onlyA = [], onlyB = [], thunderA = [], thunderB = [];
  SLOTS.forEach((slot, k) => {
    const sa = a.slots?.[k], sb = b.slots?.[k];
    if (!sa || !sb) return;
    const name = slot.name.toLowerCase();
    if (sa.prec >= AGREE.slotWet && sb.prec < AGREE.slotDry) onlyA.push(`${name} ${fmt(sa.prec, 1)} mm`);
    if (sb.prec >= AGREE.slotWet && sa.prec < AGREE.slotDry) onlyB.push(`${name} ${fmt(sb.prec, 1)} mm`);
    if (isThunder(sa.code) && !isThunder(sb.code)) thunderA.push(name);
    if (isThunder(sb.code) && !isThunder(sa.code)) thunderB.push(name);
  });
  const timing = onlyA.length + onlyB.length;
  if (timing) {
    const parts = [];
    if (onlyA.length) parts.push(`solo ${na}: ${onlyA.join(', ')}`);
    if (onlyB.length) parts.push(`solo ${nb}: ${onlyB.join(', ')}`);
    issues.push({ points: timing >= 2 ? 2 : 1, text: `Pioggia in fasce diverse (${parts.join('; ')})` });
  } else {
    ok.push('pioggia coerente nelle fasce orarie');
  }

  // 3. Quanta pioggia: se piove per entrambi, differenza relativa e assoluta. Saltato se
  // la pioggia cade in fasce diverse: il confronto dei totali sarebbe fuorviante.
  const pa = a.prec ?? 0, pb = b.prec ?? 0;
  if (!timing && pa >= AGREE.slotWet && pb >= AGREE.slotWet) {
    const hi = Math.max(pa, pb), lo = Math.min(pa, pb);
    if (hi >= lo * AGREE.rainRatio && hi - lo >= AGREE.rainAbs) {
      issues.push({ points: 1, text: `Quantità di pioggia diversa: ${fmt(pa, 1)} vs ${fmt(pb, 1)} mm` });
    } else {
      ok.push('quantità di pioggia simile');
    }
  }

  // 4. Temporali previsti da un solo modello.
  if (thunderA.length || thunderB.length) {
    const parts = [];
    if (thunderA.length) parts.push(`solo ${na} (${thunderA.join(', ')})`);
    if (thunderB.length) parts.push(`solo ${nb} (${thunderB.join(', ')})`);
    issues.push({ points: 1, text: `Temporale: ${parts.join('; ')}` });
  }

  // 5. Raffiche di vento.
  if (a.gust != null && b.gust != null) {
    if (Math.abs(a.gust - b.gust) >= AGREE.gustDiff && Math.max(a.gust, b.gust) >= AGREE.gustMin) {
      issues.push({ points: 1, text: `Raffiche diverse: ${fmt(a.gust)} vs ${fmt(b.gust)} km/h` });
    } else {
      ok.push('raffiche simili');
    }
  }

  const score = issues.reduce((sum, x) => sum + x.points, 0);
  const level = score === 0 ? { cls: 'good', label: 'Modelli concordi' }
    : score === 1 ? { cls: 'mid', label: 'Lievi differenze' }
      : { cls: 'bad', label: 'Modelli discordi' };
  const lines = issues.map((x) => `• ${x.text}`);
  if (ok.length) lines.push(`${issues.length ? 'Concordi su' : 'Concordano su'}: ${ok.join(', ')}.`);
  return { ...level, score, reason: `${level.label} (${na} vs ${nb})\n${lines.join('\n')}` };
}

// Fasce orarie in cui viene suddivisa ogni giornata.
const SLOTS = [
  { from: 0, name: 'Notte' },
  { from: 6, name: 'Mattina' },
  { from: 12, name: 'Pomeriggio' },
  { from: 18, name: 'Sera' },
];
const SLOT_HOURS = 6;
// Giorni mostrati in "Prossimi giorni": oggi, domani e dopodomani.
const DAILY_DAYS = 3;
const slotRange = (s) => `${s.from}–${s.from + SLOT_HOURS}`;

// Codice WMO che rappresenta una fascia, pesato su tutta la fascia:
// - temporale (codice ≥ 95) anche in una sola ora: vince sempre (pericoloso);
// - precipitazioni (codici ≥ 51) solo se rilevanti per la fascia: almeno
//   SLOT_WET_HOURS ore con pioggia oppure almeno SLOT_WET_MM mm in totale; allora vince
//   il codice di pioggia più severo;
// - altrimenti il tempo prevalente (più ore) tra i gruppi sereno (0–1), nuvoloso (2–3)
//   e nebbia (45–48), ignorando le ore di pioggerella; a parità prevale il gruppo peggiore,
//   nel gruppo il codice più frequente (a parità il più alto). I mm restano visibili sotto
//   la temperatura della fascia anche quando l'icona non è di pioggia.
const SLOT_WET_CODE = 51;
const SLOT_THUNDER_CODE = 95;
const SLOT_WET_HOURS = 2; // ore con pioggia (su 6) perché la fascia sia "di pioggia"…
const SLOT_WET_MM = 1; // …oppure mm totali nella fascia
const codeGroup = (c) => (c <= 1 ? 0 : c <= 3 ? 1 : 2);

function slotCode(codes, precs = []) {
  const thunder = codes.filter((c) => c >= SLOT_THUNDER_CODE);
  if (thunder.length) return Math.max(...thunder);
  const wet = codes.filter((c) => c >= SLOT_WET_CODE);
  const mm = precs.reduce((a, p) => a + (p ?? 0), 0);
  if (wet.length && (wet.length >= SLOT_WET_HOURS || mm >= SLOT_WET_MM)) return Math.max(...wet);
  const dry = codes.filter((c) => c < SLOT_WET_CODE);
  // Tutte le ore con pioggerella trascurabile: si mostra comunque la più lieve.
  if (!dry.length) return Math.min(...codes);
  const count = (list, key) => list.reduce((m, c) => m.set(key(c), (m.get(key(c)) || 0) + 1), new Map());
  const pickMax = (m) => [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const group = pickMax(count(dry, codeGroup));
  return pickMax(count(dry.filter((c) => codeGroup(c) === group), (c) => c));
}

// Indici orari di una fascia. In Open-Meteo pioggia e codice meteo del timestamp T si
// riferiscono all'ora precedente (T-1, T]: la fascia 6–12 usa quindi i timestamp 07…12
// (la 24 è la mezzanotte del giorno dopo). Stessa convenzione di windowHours().
function slotIndices(day, slot, hourIdx) {
  return Array.from({ length: SLOT_HOURS }, (_, k) => {
    const end = slot.from + k + 1;
    return hourIdx.get(end === 24 ? `${nextDate(day)}T00:00` : `${day}T${String(end).padStart(2, '0')}:00`);
  });
}

// Pioggia totale del giorno (ore 0–24) dai dati orari, con la stessa convenzione delle
// fasce: coincide sempre con la somma delle quattro fasce. Il precipitation_sum di
// Open-Meteo somma invece i timestamp 00…23, cioè dalle 23 del giorno prima alle 23.
// null se manca anche una sola ora (si ripiega allora sul valore giornaliero dell'API).
function dayPrecipitation(h, day, hourIdx) {
  const idx = SLOTS.flatMap((s) => slotIndices(day, s, hourIdx));
  if (idx.some((i) => i == null || h.precipitation[i] == null)) return null;
  return Math.round(idx.reduce((sum, i) => sum + h.precipitation[i], 0) * 10) / 10;
}

// Riassume una fascia di 6 ore dai dati orari di un modello. Restituisce null se
// il modello copre meno di metà della fascia (es. oltre il suo orizzonte).
// `nowIso`: per la fascia in corso l'icona considera solo le ore non ancora trascorse.
function slotSummary(h, indices, nowIso = null) {
  const idx = indices.filter((i) => i != null && h.temperature_2m[i] != null);
  if (idx.length < SLOT_HOURS / 2) return null;
  const temps = idx.map((i) => h.temperature_2m[i]);
  // Ore non ancora trascorse: il valore del timestamp T copre l'ora (T-1, T], quindi
  // l'ora corrente è ancora "da venire" solo se T è successivo all'ora piena attuale.
  const ahead = nowIso ? idx.filter((i) => state.data.hourly.time[i] > nowIso) : [];
  const codeIdx = ahead.length ? ahead : idx;
  return {
    code: slotCode(codeIdx.map((i) => h.weather_code[i] ?? 0), codeIdx.map((i) => h.precipitation[i])),
    isDay: h.is_day[codeIdx[Math.floor(codeIdx.length / 2)]],
    temp: temps.reduce((a, b) => a + b, 0) / temps.length,
    tmin: Math.min(...temps),
    tmax: Math.max(...temps),
    prec: idx.reduce((a, i) => a + (h.precipitation[i] ?? 0), 0),
  };
}

// `pops`: probabilità di pioggia per fascia (dato comune ai due modelli, dall'ensemble):
// stesso valore nei box ICON-2I e ICON-EU.
function renderSlots(m, slots, pastUntil) {
  return `<div class="slots">${slots.map((sl, k) => {
    const past = k < pastUntil ? ' past' : '';
    const label = `${SLOTS[k].name} (${slotRange(SLOTS[k])})`;
    if (!sl) return `<div class="slot na${past}" title="${m.name} · ${label}: dati non disponibili">—</div>`;
    const tip = `${m.name} · ${label}: ${describe(sl.code)}, ${fmt(sl.tmin)}–${fmt(sl.tmax)} °C, ${fmt(sl.prec, 1)} mm`;
    return `<div class="slot${past}" title="${esc(tip)}">
      ${icon(sl.code, sl.isDay, 24, describe(sl.code))}
      <b>${fmt(sl.temp)}<span class="deg">°</span></b>
      <span class="slot-rain"><span class="slot-mm ${sl.prec >= 0.1 ? 'wet' : 'dry'}">${sl.prec >= 0.1 ? fmt(sl.prec, 1) : '\u00a0'}</span></span>
    </div>`;
  }).join('')}${slotTicks()}</div>`;
}

// Riga della probabilità di pioggia, condivisa dai due modelli (viene dall'ensemble):
// terzo segmento della "pillola", con una cella per fascia allineata alle fasce dei box.
// Ogni cella: barra riempita in proporzione + percentuale; al tocco il dettaglio.
function renderPopRow(pops, pastUntil) {
  const cells = SLOTS.map((s, k) => {
    const x = pops[k];
    const past = k < pastUntil ? ' past' : '';
    if (x?.pop == null) return `<div class="pop-cell na${past}">—</div>`;
    const tip = `Probabilità di pioggia · ${s.name} (${slotRange(s)})\n${chanceText(x, 'nella fascia')}\n(dato comune ai due modelli)`;
    return `<div class="pop-cell${past}${x.pop >= 20 ? ' high' : ''}" title="${esc(tip)}" data-tip="${esc(tip)}">
      <span class="pop-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, x.pop))}%"></i></span>
      <span class="pop-val">${x.popExact ? '' : '~'}${fmt(x.pop)}%</span>
    </div>`;
  }).join('');
  return `<div class="pop-row" aria-label="Probabilità di pioggia per fascia">
    <span class="pop-label" title="Probabilità di pioggia (comune ai due modelli)">${DROP}<span class="pop-label-text">Probabilità di pioggia</span></span>
    <div class="pop-cells">${cells}</div>
  </div>`;
}

// Probabilità di pioggia per ciascuna fascia del giorno (stesso calcolo dei tragitti sulle
// 6 ore della fascia); null dove mancano dati orari.
function slotChances(day, hourIdx) {
  return SLOTS.map((s) => {
    const idx = slotIndices(day, s, hourIdx);
    if (idx.some((i) => i == null)) return null;
    return windowRainChance(idx.map((i) => ({ stamp: state.data.hourly.time[i], weight: 1, i })));
  });
}

// Ore di confine tra le fasce (6, 12, 18) sulla linea tratteggiata, sopra i separatori.
const slotTicks = () => SLOTS.slice(1).map((s, k) =>
  `<span class="slot-tick" style="left:${((k + 1) * 100) / SLOTS.length}%" aria-hidden="true">${s.from}</span>`).join('');

// Orari di alba e tramonto (già nell'ora locale della località). La probabilità di
// pioggia non è indicata per il giorno intero ma fascia per fascia (renderSlots).
function sunTimes(daily, d) {
  const rise = daily.sunrise?.[d], set = daily.sunset?.[d];
  if (!rise || !set) return '';
  return `<div class="sun">
    <span class="sun-pill rise" title="Alba">${sunEventIcon('rise', 18)}${hourLabel(rise)}</span>
    <span class="sun-pill set" title="Tramonto">${sunEventIcon('set', 18)}${hourLabel(set)}</span>
  </div>`;
}

const DROP = '<svg class="drop" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.6c2.4 3 4.4 5.5 4.4 8.1a4.4 4.4 0 0 1-8.8 0c0-2.6 2-5.1 4.4-8.1z"/></svg>';

// --- Tragitti in bici ("Bike") ------------------------------------------------------
// Elenco di tragitti, ognuno con le sue finestre orarie (ora locale della località). Per
// ogni finestra si valuta se pioverà confrontando i due modelli e la probabilità
// dall'ensemble. Oggi c'è un'unica voce: gli "intervalli monitorati" (nome e al massimo 3
// intervalli) scelti nella pagina Impostazioni (settings.html, salvati in settings.watch).
let BIKE_COMMUTES = [store.getWatch()];
const BIKE_WET_MM = 0.2; // mm nel tragitto oltre cui un modello "vede" pioggia
// Soglie del verdetto, che combina i due modelli con la probabilità dell'ensemble:
const BIKE_POP_BOTH = 30; // Pioggia se entrambi i modelli vedono pioggia e prob. ≥ 30%…
const BIKE_POP_ONE = 60; // …oppure se la vede un solo modello e prob. ≥ 60%…
const BIKE_POP_ANY = 80; // …oppure, comunque, con prob. ≥ 80%
const BIKE_POP_DRY = 20; // Asciutto se nessun modello vede pioggia e prob. < 20%

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function nextDate(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Ore dell'API che coprono la finestra, con il peso della sovrapposizione.
// In Open-Meteo pioggia e probabilità si riferiscono all'ora PRECEDENTE il timestamp:
// il valore delle 08:00 copre 07:00–08:00.
function windowHours(day, w) {
  const a = toMinutes(w.from), b = toMinutes(w.to);
  const out = [];
  for (let h = Math.floor(a / 60); h * 60 < b; h++) {
    const overlap = Math.min(b, (h + 1) * 60) - Math.max(a, h * 60);
    if (overlap <= 0) continue;
    const end = h + 1;
    const stamp = end === 24 ? `${nextDate(day)}T00:00` : `${day}T${String(end).padStart(2, '0')}:00`;
    out.push({ stamp, weight: overlap / 60 });
  }
  return out;
}

// Probabilità che piova durante il tragitto.
// Metodo esatto: quota di scenari dell'ensemble con almeno ENSEMBLE_WET_MM nel tragitto
// (ore parziali pesate come per i mm). La massima delle probabilità orarie invece
// sottostima: scenari diversi possono vedere pioggia in ore diverse dello stesso tragitto.
// Se l'ensemble non copre il tragitto si ripiega sulla massima oraria (popExact = false).
// Stessa soglia con cui un modello "vede pioggia" (BIKE_WET_MM): modelli e probabilità
// parlano della stessa pioggia. (Con 0,1 mm contavano anche poche gocce.)
const ENSEMBLE_WET_MM = BIKE_WET_MM;

// Descrizione a parole dei mm nel tragitto (valore tipico degli scenari con pioggia).
function rainWords(mm) {
  if (mm < 0.5) return 'qualche goccia';
  if (mm < 2) return 'pioggia debole';
  if (mm < 5) return 'pioggia moderata';
  return 'pioggia forte';
}

// Vero se nelle ore del tragitto l'ensemble ha dati ogni 3 ore (oltre ~2 giorni): i valori
// orari sono allora uguali a gruppi di tre e il momento esatto della pioggia non è noto.
function ensembleCoarse(ens, idx) {
  return idx.some((i) => {
    const rainy = ens.members.filter((s) => (s[i] ?? 0) > 0);
    if (rainy.length < 3) return false; // senza pioggia non si può dire (e non serve)
    return rainy.every((s) => s[i] === s[i - 1] || s[i] === s[i + 1]);
  });
}

function windowRainChance(hrs) {
  const ens = state.data.ensemble;
  if (ens?.members?.length) {
    const idx = hrs.map((x) => ens.time.indexOf(x.stamp));
    if (idx.every((i) => i >= 0)) {
      const sums = ens.members
        .map((serie) => (idx.some((i) => serie[i] == null) ? null : idx.reduce((sum, i, k) => sum + serie[i] * hrs[k].weight, 0)))
        .filter((v) => v != null);
      if (sums.length >= ens.members.length / 2) {
        const wetSums = sums.filter((v) => v >= ENSEMBLE_WET_MM - 1e-9).sort((a, b) => a - b);
        const wet = wetSums.length;
        return {
          pop: Math.round((100 * wet) / sums.length), popExact: true, popMembers: wet, popTotal: sums.length,
          // quanta pioggia negli scenari bagnati: valore tipico (mediana) e massimo
          wetTypical: wet ? wetSums[Math.floor((wet - 1) / 2)] : null,
          wetMax: wet ? wetSums[wet - 1] : null,
          coarse: ensembleCoarse(ens, idx),
        };
      }
    }
  }
  const pops = hrs.map((x) => (x.i == null ? null : state.data.hourly.precipitation_probability?.[x.i])).filter((v) => v != null);
  return { pop: pops.length ? Math.max(...pops) : null, popExact: false };
}

// Testo del dettaglio della probabilità (tragitti e dettaglio orario): scenari, quantità
// di pioggia negli scenari bagnati e nota sull'orario approssimato.
function chanceText(x, where) {
  if (x.pop == null) return 'Probabilità n.d.';
  if (!x.popExact) return `Probabilità ~${x.pop}% (stima Open-Meteo: ensemble non disponibile)`;
  let txt = `Probabilità di pioggia ${where} ${x.pop}% (${x.popMembers} ${x.popMembers === 1 ? 'scenario' : 'scenari'} su ${x.popTotal} di ${state.data.ensemble.model} con almeno ${fmt(ENSEMBLE_WET_MM, 1)} mm)`;
  if (x.popMembers) {
    const amount = x.popMembers === 1 ? `${fmt(x.wetMax, 1)} mm` : `tipicamente ${fmt(x.wetTypical, 1)} mm, al massimo ${fmt(x.wetMax, 1)} mm`;
    txt += `\n${x.popMembers === 1 ? "Nell'unico scenario" : 'Negli scenari'} con pioggia: ${amount} (${rainWords(x.wetTypical)})`;
  }
  if (x.coarse) txt += "\nOrario approssimato: a questa distanza l'ensemble ha dati ogni 3 ore";
  return txt;
}

// Verdetto per una finestra: combina quanti modelli "vedono pioggia" (≥ BIKE_WET_MM) con
// la probabilità dell'ensemble. Non si fa una media dei mm tra i modelli (2 e 0 mm
// darebbero "1 mm" nascondendo il disaccordo).
//   Pioggia  = entrambi + prob ≥ 30% · uno solo + prob ≥ 60% · qualunque + prob ≥ 80%
//   Asciutto = nessuno + prob < 20%
//   Rischio  = nessun modello, ma prob ≥ 20%  ·  Incerto = gli altri casi
// Senza probabilità si giudica solo sui modelli (tutti → Pioggia, alcuni → Incerto).
function bikeVerdict(wet, total, pop) {
  const all = wet === total, some = wet > 0;
  if (pop == null) {
    if (all) return { status: 'wet', why: 'tutti i modelli vedono pioggia (probabilità non disponibile)' };
    if (some) return { status: 'mixed', why: 'un solo modello vede pioggia (probabilità non disponibile)' };
    return { status: 'dry', why: 'nessun modello vede pioggia (probabilità non disponibile)' };
  }
  const p = `probabilità ${pop}%`;
  let models;
  if (total === 1) models = some ? "l'unico modello disponibile vede pioggia" : "l'unico modello disponibile non vede pioggia";
  else models = all ? 'entrambi i modelli vedono pioggia' : some ? 'un solo modello vede pioggia' : 'nessun modello vede pioggia';
  if (all && total > 1 && pop >= BIKE_POP_BOTH) return { status: 'wet', why: `${models} e ${p} (≥ ${BIKE_POP_BOTH}%)` };
  if (some && pop >= BIKE_POP_ONE) return { status: 'wet', why: `${models} e ${p} (≥ ${BIKE_POP_ONE}%)` };
  if (pop >= BIKE_POP_ANY) return { status: 'wet', why: `${p} (≥ ${BIKE_POP_ANY}%), anche se ${models}` };
  if (!some && pop < BIKE_POP_DRY) return { status: 'dry', why: `${models} e ${p} (< ${BIKE_POP_DRY}%)` };
  if (!some) return { status: 'risk', why: `${models}, ma ${p} (≥ ${BIKE_POP_DRY}%)` };
  return { status: 'mixed', why: `${models}, ${p}` };
}

function bikeWindow(day, w, hourIdx) {
  const { hourly } = state.data;
  const hrs = windowHours(day, w).map((x) => ({ ...x, i: hourIdx.get(x.stamp) }));
  const models = MODELS.map((m) => {
    const p = hourly.models[m.key].precipitation;
    if (hrs.some((x) => x.i == null || p[x.i] == null)) return { m, mm: null };
    return { m, mm: hrs.reduce((sum, x) => sum + p[x.i] * x.weight, 0) };
  });
  const avail = models.filter((x) => x.mm != null);
  const chance = windowRainChance(hrs);
  const { pop } = chance;
  if (!avail.length) return { w, status: 'na', models, avail, ...chance };

  const wet = avail.filter((x) => x.mm >= BIKE_WET_MM).length;
  const { status, why } = bikeVerdict(wet, avail.length, pop);
  const mms = avail.map((x) => x.mm);
  return { w, status, why, wet, models, avail, ...chance, mean: mms.reduce((a, b) => a + b, 0) / mms.length, min: Math.min(...mms), max: Math.max(...mms) };
}

// Icone dello stato (16×16, tratto): sole = asciutto, nuvola = rischio,
// nuvola con goccia = incerto, ombrello = pioggia.
const BIKE_CLOUD = '<path d="M4.6 11.2h6.9a2.6 2.6 0 0 0 .2-5.2 3.6 3.6 0 0 0-6.9 1A2.1 2.1 0 0 0 4.6 11.2z"/>';
const BIKE_STATUS = {
  dry: { label: 'Asciutto', icon: '<circle cx="8" cy="8" r="2.9"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"/>' },
  risk: { label: 'Rischio', icon: `<g transform="translate(0 .6)">${BIKE_CLOUD}</g>` },
  mixed: { label: 'Incerto', icon: `<g transform="translate(0 -1.6)">${BIKE_CLOUD}</g><path d="M8 11.8l-.9 2.4"/>` },
  wet: { label: 'Pioggia', icon: '<path d="M2.2 8.3a5.8 5.8 0 0 1 11.6 0z"/><path d="M8 8.3v4.6a1.4 1.4 0 0 1-2.8 0"/><path d="M8 2.5v-.9"/>' },
  na: { label: 'n.d.', icon: '' },
};
const BIKE_ICON = '<svg class="bike-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h6l3.5 7.5M9 9l3.5 7.5L15 9M8 6.5h3M15 9l-1-2.5h2.5"/></svg>';

function renderBike(commute, day, hourIdx, today, nowMin) {
  const items = commute.windows.map((w) => bikeWindow(day, w, hourIdx));
  if (items.every((x) => x.status === 'na')) return '';
  const chips = items.map((x) => {
    const st = BIKE_STATUS[x.status];
    const past = day === today && toMinutes(x.w.to) <= nowMin ? ' past' : '';
    const range = `${x.w.from}–${x.w.to}`;
    let mm = '';
    // Media dei mm solo se tutti i modelli vedono pioggia, altrimenti l'intervallo min–max.
    const mmRange = `${x.min < 0.05 ? '0' : fmt(x.min, 1)}–${fmt(x.max, 1)} mm`;
    if (x.status === 'wet') mm = x.wet === x.avail.length ? `${fmt(x.mean, 1)} mm` : mmRange;
    else if (x.status === 'mixed') mm = mmRange;
    const only = x.avail.length === 1 ? `<span class="bike-only">solo ${x.avail[0].m.short}</span>` : '';
    const detail = x.models.map((y) => `${y.m.name}: ${y.mm == null ? 'n.d.' : `${fmt(y.mm, 1)} mm`}`).join(' · ');
    const popTxt = chanceText(x, 'nel tragitto');
    // Dettaglio: tooltip su desktop, avviso al tocco su mobile (dove mm e "solo EU" sono nascosti).
    const tip = `Tragitto ${x.w.from}–${x.w.to}: ${st.label}${mm ? ` (${mm})` : ''}${x.why ? `\nPerché: ${x.why}` : ''}\n${detail}${x.avail.length === 1 ? ` (solo ${x.avail[0].m.name})` : ''}\n${popTxt}`;
    return `<button type="button" class="bike-chip st-${x.status}${past}" title="${esc(tip)}" data-tip="${esc(tip)}">
      <span class="bike-time">${range}</span>
      <span class="bike-info">
        <span class="bike-st" aria-label="${st.label}">${st.icon ? `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">${st.icon}</svg>` : ''}<span class="bike-st-label">${st.label}</span></span>
        ${mm ? `<span class="bike-mm">${mm}</span>` : ''}${only}
        ${x.pop != null ? `<span class="bike-pop">${DROP}${x.popExact ? '' : '~'}${fmt(x.pop)}%</span>` : ''}
      </span>
    </button>`;
  }).join('');
  return `<div class="bike">
    <span class="bike-label">${BIKE_ICON}<span>${esc(commute.label)}</span></span>
    <div class="bike-chips">${chips}</div>
  </div>`;
}

// Legenda delle fonti (pallino colorato + nome), ordine = colonne dei box.
const SOURCES_LEGEND = `<div class="sources">${MODELS.map((m) => `<span><i class="dot-${m.key}"></i>${m.name}</span>`).join('')}</div>`;

function renderDaily() {
  const { daily, hourly, utcOffset } = state.data;
  const nowIso = localNowIso(utcOffset);
  const today = nowIso.slice(0, 10);
  const nowHour = Number(nowIso.slice(11, 13));
  const hourIdx = new Map(hourly.time.map((t, i) => [t, i]));
  const nowMin = toMinutes(localDateTime(Date.now(), state.data.timezone, utcOffset).time);

  const rows = daily.time
    .map((day, d) => ({ day, d }))
    .filter(({ day }) => day >= today)
    .slice(0, DAILY_DAYS)
    .map(({ day, d }) => {
    // Fasce già trascorse di oggi: mostrate attenuate.
    const pastUntil = day === today ? SLOTS.filter((s) => s.from + SLOT_HOURS <= nowHour).length : 0;

    const vals = Object.fromEntries(MODELS.map((m) => {
      const x = daily.models[m.key];
      const slots = SLOTS.map((s) => slotSummary(hourly.models[m.key], slotIndices(day, s, hourIdx),
        day === today ? nowIso : null));
      return [m.key, {
        code: x.weather_code[d], tmax: x.temperature_2m_max[d], tmin: x.temperature_2m_min[d],
        prec: dayPrecipitation(hourly.models[m.key], day, hourIdx) ?? x.precipitation_sum[d],
        gust: x.wind_gusts_10m_max[d], slots,
      }];
    }));
    const hasSlots = (v) => v.slots.some(Boolean);
    if (MODELS.every((m) => vals[m.key].tmax == null && !hasSlots(vals[m.key]))) return '';

    const ag = agreement(vals.i2i, vals.eu);
    const pops = slotChances(day, hourIdx);
    const cells = MODELS.map((m) => {
      const v = vals[m.key];
      // Il modello è indicato dal pallino colorato nel box e dalla legenda nel titolo.
      if (v.tmax == null && !hasSlots(v)) return `<div class="dm dm-empty m-${m.key}"><span class="muted small">${m.name} oltre l’orizzonte</span></div>`;
      // Giornata coperta solo in parte (fine dell'orizzonte del modello): solo le fasce.
      if (v.tmax == null) {
        return `<div class="dm m-${m.key}" title="${m.name}">
          <span class="partial muted small">${m.name}: dati solo per parte della giornata</span>
          ${renderSlots(m, v.slots, pastUntil)}
        </div>`;
      }
      return `<div class="dm m-${m.key}" title="${m.name}">
        ${icon(v.code, 1, 36)}
        <span class="temps"><b>${fmt(v.tmax)}°</b><span class="muted">${fmt(v.tmin)}°</span></span>
        <span class="prec ${v.prec >= 0.1 ? 'wet' : ''}">${fmt(v.prec, 1)}<small> mm</small></span>
        <span class="gust muted">${fmt(v.gust)}<small> km/h</small></span>
        ${renderSlots(m, v.slots, pastUntil)}
      </div>`;
    }).join('');

    let delta = '';
    if (ag) {
      const dmax = vals.i2i.tmax - vals.eu.tmax;
      const dp = (vals.i2i.prec ?? 0) - (vals.eu.prec ?? 0);
      const diff = `Δ max ${fmtSigned(dmax)}° · Δ pioggia ${fmtSigned(dp)} mm`;
      // Le differenze (Δ) sono mostrate solo nel tooltip/avviso dell'etichetta.
      const reason = `${ag.reason}\n${diff} (2I − EU)`;
      delta = `<div class="dd"><button type="button" class="agree ${ag.cls}" title="${esc(reason)}" data-reason="${esc(reason)}" aria-label="${esc(reason)}">${ag.label}<span class="agree-i" aria-hidden="true">i</span></button></div>`;
    }
    // Ogni giorno è una card con il titolo "Oggi" / "Domani" / "Dopodomani", la data e la
    // legenda delle fonti.
    const t = dayTitle(day, today);
    return `<section class="card day-card">
      <div class="card-head">
        <h2>${t.title} <span class="day-date">${t.date}</span></h2>
        ${SOURCES_LEGEND}
      </div>
      <div class="day">
        <div class="day-name">${sunTimes(daily, d)}</div>
        <div class="day-models">${cells}${renderPopRow(pops, pastUntil)}</div>
        ${delta}
        ${bikeArea(BIKE_COMMUTES.map((c) => renderBike(c, day, hourIdx, today, nowMin)).join(''))}
      </div>
    </section>`;
  }).join('');

  // Le fasce sono indicate dentro ogni box dalle ore di confine 6/12/18 (slotTicks).
  $('#daily').innerHTML = rows;
  fitBikes();
}

const bikeArea = (html) => (html.trim() ? `<div class="bike-area"><div class="bikes">${html}</div></div>` : '');

// Tutti i blocchi dei tragitti (work, school, tutti i giorni) hanno la stessa larghezza:
// quella del blocco più largo (--bike-chip-w). La disposizione è nel CSS: su desktop i
// tragitti sulla stessa riga, su mobile uno per riga a colonne uguali (--bike-max).
// Va rieseguita dopo ogni render di "Prossimi giorni" e al ridimensionamento.

function fitBikes() {
  const daily = $('#daily');
  daily.classList.remove('bikes-sized');
  // Misura alla larghezza naturale (.bikes-measure): con la griglia stretta i blocchi
  // verrebbero compressi e la misura risulterebbe troppo piccola.
  daily.classList.add('bikes-measure');
  const chips = [...daily.querySelectorAll('.bike-chip')];
  const width = Math.ceil(Math.max(0, ...chips.map((c) => c.getBoundingClientRect().width)));
  daily.classList.remove('bikes-measure');
  if (!width) return; // sezione non visibile: niente da misurare
  daily.style.setProperty('--bike-chip-w', `${width}px`);
  daily.style.setProperty('--bike-max', String(Math.max(...BIKE_COMMUTES.map((c) => c.windows.length)))); // layout mobile
  daily.classList.add('bikes-sized');

  // Desktop: i tragitti stanno nelle colonne dei modelli solo se ci entrano; altrimenti
  // (o con il giorno su una colonna, ≤720 px) uno dopo l'altro. Su mobile decide il CSS.
  daily.classList.remove('bikes-flow');
  // Soglie sulla larghezza della colonna (come le container query "side" del CSS), non
  // dello schermo: su desktop la colonna dei giorni è stretta come un telefono.
  const colWidth = daily.clientWidth;
  if (colWidth <= 560) return;
  const col = daily.querySelector('.dm')?.getBoundingClientRect().width || 0;
  const gap = 6;
  const chipsWidth = (c) => c.windows.length * width + (c.windows.length - 1) * gap;
  const labelOf = (i) => daily.querySelectorAll('.bikes')[0]?.children[i]?.querySelector('.bike-label')?.getBoundingClientRect().width || 0;
  const fits = BIKE_COMMUTES.every((c, i) => (i === 0 ? chipsWidth(c) : labelOf(i) + 12 + chipsWidth(c)) <= col);
  if (colWidth <= 720 || !fits) daily.classList.add('bikes-flow');
}

function buildVarTabs() {
  $('#var-tabs').innerHTML = Object.entries(VARIABLES)
    .map(([k, v]) => `<button type="button" role="tab" data-var="${k}">${v.label}</button>`).join('');
}

function syncControls() {
  const { variable, range } = state.settings;
  document.querySelectorAll('#var-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.var === variable)));
  document.querySelectorAll('#range-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
}

function renderChartSection() {
  if (!state.data || $('#forecast').hidden) return;
  syncControls();
  const { hourly } = state.data;
  const cfg = VARIABLES[state.settings.variable] || VARIABLES.rain;
  // Parte dall'ora piena precedente a quella attuale (alle 20:32 → dalle 19)
  const start = Math.max(0, nowIndex() - 1);
  const len = state.settings.range === 'all' ? Infinity : Number(state.settings.range);
  const end = Math.min(hourly.time.length, start + len);
  const times = hourly.time.slice(start, end);

  const series = [];
  for (const s of cfg.series) {
    for (const m of MODELS) {
      series.push({
        cls: `s-${m.key}`, dash: s.dash, type: cfg.type, model: m, varLabel: s.label,
        values: hourly.models[m.key][s.v].slice(start, end),
      });
    }
  }

  // Probabilità di pioggia ora per ora (stesso calcolo della tabella oraria), scala a destra.
  if (cfg.pop) {
    series.push({
      cls: 's-pop', axis: 'y2', label: 'Probabilità', unitLabel: '%',
      values: times.map((t, k) => windowRainChance([{ stamp: t, weight: 1, i: start + k }]).pop),
    });
  }

  renderChart($('#chart'), {
    times, series, unit: cfg.unit, decimals: cfg.decimals, yFloor: cfg.yFloor, yCeil: cfg.yCeil,
    y2: cfg.pop ? { max: 100, ticks: [0, 25, 50, 75, 100], unit: '%' } : null,
    minSpan: cfg.minSpan, nowIso: localNowIso(state.data.utcOffset),
    ariaLabel: `${cfg.label}: confronto ICON-2I e ICON-EU`,
    tooltip: (i) => {
      const rows = series.map((s) => (s.axis === 'y2'
        ? `<div class="tip-row"><i class="sw ${s.cls}"></i>${s.label}<b>${tipValue(s.values[i], 0, s.unitLabel)}</b></div>`
        : `<div class="tip-row"><i class="sw ${s.cls}${s.dash ? ' dash' : ''}"></i>${s.model.name}${s.varLabel ? ` <span class="muted">${s.varLabel}</span>` : ''}<b>${tipValue(s.values[i], cfg.decimals, cfg.unit)}</b></div>`)).join('');
      const a = series[0].values[i], b = series[1].values[i];
      const diff = a != null && b != null ? `<div class="tip-diff muted">Δ 2I − EU: ${fmtSigned(a - b, cfg.decimals)} ${cfg.unit}</div>` : '';
      return `<div class="tip-head">${dayShort(times[i])} · ${hourLabel(times[i])}</div>${rows}${diff}`;
    },
  });

  const note = [];
  let legend = cfg.series.some((s) => s.dash) ? 'Linea continua: velocità media · tratteggio: raffiche. ' : '';
  if (cfg.pop) legend = `Barre: pioggia in mm (ICON-2I, ICON-EU) · area azzurra: probabilità di pioggia (scenari ${state.data.ensemble?.model || 'ensemble'} con almeno ${fmt(ENSEMBLE_WET_MM, 1)} mm, scala a destra). `;
  for (const m of MODELS) {
    if (!inModelDomain(m, state.loc.lat, state.loc.lon)) note.push(`${m.name} non copre questa località.`);
    else {
      const last = availability(m.key);
      if (last >= 0 && last < end - 1) note.push(`${m.name} disponibile fino a ${dayShort(hourly.time[last])} ore ${hourLabel(hourly.time[last])}.`);
    }
  }
  $('#chart-note').textContent = legend + note.join(' ');
}

// Cella della probabilità oraria: stesso calcolo dei tragitti (scenari dell'ensemble con
// almeno 0,2 mm nell'ora), dettaglio in tooltip/avviso al tocco; "~" = stima Open-Meteo
// (oltre l'orizzonte dell'ensemble). Sfondo azzurro più intenso al crescere della probabilità.
function popCell(i) {
  const t = state.data.hourly.time[i];
  const x = windowRainChance([{ stamp: t, weight: 1, i }]);
  if (x.pop == null) return '<td class="first num pop-cell na">—</td>';
  const tip = `${dayShort(t)} ore ${String(Number(t.slice(11, 13)) - 1).padStart(2, '0')}–${t.slice(11, 13)}\n${chanceText(x, "nell'ora")}`;
  const tint = `background: color-mix(in srgb, var(--rain) ${Math.round(x.pop * 0.3)}%, transparent)`;
  const val = x.pop > 0 ? `${x.popExact ? '' : '~'}${fmt(x.pop)}<small>%</small>` : '<span class="muted">0</span>';
  return `<td class="first num pop-cell" style="${tint}" title="${esc(tip)}" data-tip="${esc(tip)}">${val}</td>`;
}

// Sezione "Dettaglio orario" collassabile (chiusa di default, stato ricordato).
function syncHourlyCollapse() {
  const open = !!state.settings.hourlyOpen;
  $('#hourly-toggle').setAttribute('aria-expanded', String(open));
  $('#hourly-hint').textContent = open ? 'Nascondi' : 'Mostra';
  $('#hourly-body').hidden = !open;
  $('#hourly-card').classList.toggle('open', open);
}

function renderHourlyTable() {
  syncHourlyCollapse();
  if (!state.settings.hourlyOpen) return; // la tabella viene costruita solo quando è visibile
  const { hourly } = state.data;
  const start = Math.max(0, nowIndex());
  const limit = state.settings.showAllHours ? hourly.time.length : Math.min(hourly.time.length, start + 48);
  const H = (k) => hourly.models[k];

  let body = '';
  let prevDay = '';
  for (let i = start; i < limit; i++) {
    const t = hourly.time[i];
    const day = t.slice(0, 10);
    if (day !== prevDay) {
      body += `<tr class="day-sep"><th colspan="10">${dayRelative(t, localNowIso(state.data.utcOffset).slice(0, 10))}</th></tr>`;
      prevDay = day;
    }
    const pair = (render, cls = '') => MODELS.map((m, j) => {
      const h = H(m.key);
      const classes = [j === 0 ? 'first' : '', cls, `m-${m.key}`].filter(Boolean).join(' ');
      return h.temperature_2m[i] == null ? `<td class="${classes} na">—</td>` : `<td class="${classes}">${render(h)}</td>`;
    }).join('');
    body += `<tr>
      <th scope="row"><span class="hh">${t.slice(11, 13)}</span><span class="mm">:00</span></th>
      ${pair((h) => icon(h.weather_code[i], h.is_day[i], 26))}
      ${pair((h) => `${fmt(h.temperature_2m[i])}°`, 'num')}
      ${pair((h) => (h.precipitation[i] > 0 ? `<span class="wet">${fmt(h.precipitation[i], 1)}</span>` : '<span class="muted">0</span>'), 'num')}
      ${popCell(i)}
      ${pair((h) => `<span class="wind">${windArrow(h.wind_direction_10m[i], 12)}${fmt(h.wind_speed_10m[i])}</span>`, 'num')}
    </tr>`;
  }

  $('#hourly-table').innerHTML = `
    <thead>
      <tr class="group"><th rowspan="2" scope="col">Ora</th><th colspan="2" scope="colgroup">Cielo</th><th colspan="2" scope="colgroup">Temp. °C</th><th colspan="2" scope="colgroup">Pioggia mm</th><th rowspan="2" scope="col" class="first" title="Probabilità di pioggia nell'ora: scenari ICON-EU-EPS con almeno 0,2 mm (dato comune, non di un singolo modello). Tocca una cella per il dettaglio."><span class="lg">Prob.</span><span class="sm" aria-label="Probabilità">%</span></th><th colspan="2" scope="colgroup">Vento km/h</th></tr>
      <tr class="models">${'<th class="first c-i2i">2I</th><th class="c-eu">EU</th>'.repeat(4)}</tr>
    </thead>
    <tbody>${body}</tbody>`;

  const more = $('#more-btn');
  more.hidden = hourly.time.length - start <= 48;
  more.textContent = state.settings.showAllHours ? 'Mostra solo le prossime 48 ore' : 'Mostra tutte le ore';
}

// --- Controlli -----------------------------------------------------------------------

function bindControls() {
  $('#refresh-btn').addEventListener('click', () => { load({ force: true }); loadStation(); });
  $('#retry-btn').addEventListener('click', () => load({ force: true }));

  const showTip = (e) => {
    // Etichetta di concordanza, blocchi dei tragitti e celle "Prob.": dettaglio in un avviso.
    const el = e.target.closest('.agree[data-reason], [data-tip]');
    if (!el) return;
    const text = el.dataset.reason || el.dataset.tip;
    // Secondo tap sullo stesso elemento: chiude l'avviso.
    if (!$('#toast').hidden && $('#toast').dataset.source === text) hideToast();
    else toast(text, 9000, text);
  };
  $('#daily').addEventListener('click', showTip);
  $('#hourly-body').addEventListener('click', showTip);

  // L'avviso si chiude toccandolo o toccando un qualsiasi altro punto della pagina.
  $('#toast').addEventListener('click', hideToast);
  document.addEventListener('click', (e) => {
    if ($('#toast').hidden || e.target.closest('#toast, .agree[data-reason], [data-tip]')) return;
    hideToast();
  });

  $('#var-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-var]');
    if (!b) return;
    state.settings.variable = b.dataset.var;
    store.saveSettings({ variable: b.dataset.var });
    renderChartSection();
  });

  $('#range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    state.settings.range = b.dataset.range;
    store.saveSettings({ range: b.dataset.range });
    renderChartSection();
  });

  $('#hourly-toggle').addEventListener('click', () => {
    state.settings.hourlyOpen = !state.settings.hourlyOpen;
    store.saveSettings({ hourlyOpen: state.settings.hourlyOpen });
    renderHourlyTable();
  });

  $('#more-btn').addEventListener('click', () => {
    state.settings.showAllHours = !state.settings.showAllHours;
    store.saveSettings({ showAllHours: state.settings.showAllHours });
    renderHourlyTable();
  });

}

// --- Notifiche --------------------------------------------------------------------------

let toastTimer;
// `source` identifica chi ha aperto l'avviso (es. il motivo della concordanza), per poterlo
// richiudere con un secondo tap sullo stesso elemento.
function toast(msg, ms = 4000, source = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.source = source;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.hidden = true;
  el.dataset.source = '';
}

function setBanner(msg) {
  const el = $('#banner');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// --- Service worker --------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nuova versione disponibile: verrà usata alla prossima apertura.');
          }
        });
      });
    }).catch(() => { /* PWA non disponibile (es. file://) */ });
  });
}

// Mantiene aggiornata l'etichetta "Aggiornato x min fa" e l'ora corrente e, con l'app
// aperta, riscarica le previsioni quando la cache scade (l'orario indicato come "prossimo").
setInterval(() => {
  if (!state.data || document.visibilityState !== 'visible') return;
  if (!state.loading && navigator.onLine && !store.isFresh(state.data)) {
    load();
    return;
  }
  const prevNow = state._lastNow;
  const now = localNowIso(state.data.utcOffset);
  state._lastNow = now;
  if (prevNow && prevNow !== now) render();
  else renderHeader();
}, 60 * 1000);

// Desktop (≥ 1200 px, due colonne): il piè di pagina va in fondo alla colonna sinistra,
// sotto i giorni; altrimenti resta in fondo alla pagina. Stessa soglia di .layout in style.css.
const DESKTOP = window.matchMedia('(min-width: 1200px)');
function placeFooter() {
  const footer = $('.footer');
  if (DESKTOP.matches) $('.col-side').append(footer);
  else $('main').after(footer);
}
DESKTOP.addEventListener('change', placeFooter);
placeFooter();

// Tornando dalla pagina Impostazioni la pagina può essere ripristinata dalla cache del
// browser (bfcache) senza ricaricare i moduli: rilegge gli intervalli monitorati e ridisegna
// se sono cambiati.
function reloadWatch() {
  const watch = store.getWatch();
  if (JSON.stringify(watch) === JSON.stringify(BIKE_COMMUTES[0])) return;
  BIKE_COMMUTES = [watch];
  if (state.data) render();
}
window.addEventListener('pageshow', (e) => { if (e.persisted) reloadWatch(); });
window.addEventListener('storage', (e) => { if (e.key === 'meteo:settings') reloadWatch(); });

init();
