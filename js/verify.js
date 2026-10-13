// Pagina Verifica: per i giorni passati confronta pioggia e temperature previste (il giorno
// prima o due giorni prima, alle 23) con quelle misurate dalla centralina. I dati arrivano dal server
// (api/verify, vedi server/verify.py); qui si calcolano fasce, intervalli monitorati ed esiti.
// Convenzione oraria come nell'app: l'indice h (0…23) è la pioggia dell'ora (h, h+1].

import { MODELS, SUPPORT_MODELS, getJSON } from './api.js';
import * as store from './storage.js';
import { fmt, fmtSigned, esc, dayTitle, localDateTime, rainMarkIcon } from './weather.js';

const SLOTS = [
  { from: 0, name: 'Notte', short: 'Notte' },
  { from: 6, name: 'Mattina', short: 'Matt.' },
  { from: 12, name: 'Pomeriggio', short: 'Pom.' },
  { from: 18, name: 'Sera', short: 'Sera' },
];
const TZ = 'Europe/Rome';
// Esito di una previsione di pioggia (soglia: wetMm del server, 0,2 mm come nell'app).
// `icon`: esito disegnato con rainMarkIcon() (pioggia + X rossa / punto esclamativo); senza,
// il segno di spunta.
const OUTCOME = {
  hit: { label: 'pioggia prevista e caduta', mark: '✓', cls: 'o-good' },
  ok: { label: 'nessuna pioggia, come previsto', mark: '✓', cls: 'o-good' },
  false: { label: 'pioggia prevista ma non caduta (falso allarme)', icon: 'x', cls: 'o-bad' },
  miss: { label: 'pioggia caduta ma non prevista', icon: '!', cls: 'o-mid' },
};
// Quantità molto diversa (solo se pioggia prevista e caduta): uno almeno il doppio
// dell'altro e scarto di almeno QTY_MM, come il criterio di concordanza sulla quantità.
const QTY_RATIO = 2;
const QTY_MM = 2;
const QTY = {
  more: { label: 'molta più pioggia del previsto', icon: 'up' },
  less: { label: 'molta meno pioggia del previsto', icon: 'down' },
};
// Segno dell'esito: spunta (testo) o icona della pioggia con il distintivo.
const outcomeMark = (o, size = 22) => (o.icon ? rainMarkIcon(o.icon, size) : o.mark);
// Fasce di probabilità per l'affidabilità dell'ensemble.
const BINS = [[0, 20], [20, 50], [50, 80], [80, 101]];
// Errori gravi della probabilità: alta (≥ BAD_HIGH %) e non ha piovuto, bassa (< BAD_LOW %)
// e ha piovuto.
const BAD_HIGH = 70;
const BAD_LOW = 20;

const $ = (sel) => document.querySelector(sel);
const settings = store.getSettings();
const state = {
  lead: [1, 2].includes(settings.verifyLead) ? settings.verifyLead : 1,
  days: [7, 30].includes(settings.verifyDays) ? settings.verifyDays : 7,
  data: null,
};
const shownModels = () => {
  const only = MODELS.find((m) => m.key === settings.models);
  return only ? [only] : MODELS;
};
// Nella verifica anche i modelli di supporto (ICON-D2, AROME), che votano nel verdetto dei
// tragitti: qui si vede se aiutano davvero.
const verifyModels = () => [...shownModels(), ...SUPPORT_MODELS];
const ALL_MODELS = [...MODELS, ...SUPPORT_MODELS];

// --- Calcoli -------------------------------------------------------------------------

// Somma dei valori agli indici (con peso), null se ne manca anche uno.
function total(arr, hours) {
  if (!arr) return null;
  let s = 0;
  for (const { h, w } of hours) {
    if (arr[h] == null) return null;
    s += arr[h] * w;
  }
  return Math.round(s * 10) / 10;
}
const slotHours = (s) => Array.from({ length: 6 }, (_, k) => ({ h: s.from + k, w: 1 }));
const dayHours = () => Array.from({ length: 24 }, (_, h) => ({ h, w: 1 }));

// Ore (indice e quota di sovrapposizione) di un intervallo "HH:MM"–"HH:MM", come windowHours()
// dell'app.
function windowHours(w) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const a = toMin(w.from), b = toMin(w.to), out = [];
  for (let h = Math.floor(a / 60); h * 60 < b && h < 24; h++) {
    const overlap = Math.min(b, (h + 1) * 60) - Math.max(a, h * 60);
    if (overlap > 0) out.push({ h, w: overlap / 60 });
  }
  return out;
}

// Quota di scenari con almeno wetMm in almeno un'ora (OR delle maschere), media dei gruppi
// che coprono tutte le ore: come windowRainChance() dell'app (le ore parziali contano intere).
function chance(ens, hours) {
  if (!ens) return null;
  const parts = [];
  for (const g of ens.groups) {
    if (hours.some(({ h }) => !g.n[h])) continue;
    let mask = 0n;
    for (const { h } of hours) mask |= BigInt(g.masks[h]);
    let wet = 0;
    for (; mask; mask >>= 1n) wet += Number(mask & 1n);
    parts.push(wet / Math.min(...hours.map(({ h }) => g.n[h])));
  }
  return parts.length ? Math.round((100 * parts.reduce((a, b) => a + b, 0)) / parts.length) : null;
}

// Intervalli monitorati attivi nel giorno della settimana di `day` ("YYYY-MM-DD").
function dayWindows(watch, day) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  return watch.windows.filter((w) => w.days.includes(wd));
}

// Icona della bici, come nei tragitti della pagina principale.
const BIKE_ICON = '<svg class="bike-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h6l3.5 7.5M9 9l3.5 7.5L15 9M8 6.5h3M15 9l-1-2.5h2.5"/></svg>';

function outcome(fc, obs, wet) {
  if (fc == null || obs == null) return null;
  const f = fc >= wet - 1e-9, o = obs >= wet - 1e-9;
  return f ? (o ? 'hit' : 'false') : (o ? 'miss' : 'ok');
}

// 'more' = caduta molta più pioggia del previsto, 'less' = molta meno, null altrimenti.
function qtyOff(fc, obs, wet) {
  if (outcome(fc, obs, wet) !== 'hit' || Math.abs(fc - obs) < QTY_MM - 1e-9) return null;
  if (obs >= QTY_RATIO * fc) return 'more';
  if (fc >= QTY_RATIO * obs) return 'less';
  return null;
}

const maxOf = (a) => { const v = (a || []).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
const minOf = (a) => { const v = (a || []).filter((x) => x != null); return v.length ? Math.min(...v) : null; };

// Riepilogo sui giorni completi: esiti delle fasce, errori di pioggia e temperature per
// modello, affidabilità della probabilità.
function summarize(days, wet) {
  const full = days.filter((d) => d.observed.complete && !d.today);
  const watch = store.getWatch();
  const models = Object.fromEntries(ALL_MODELS.map((m) => [m.key, {
    counts: { hit: 0, ok: 0, false: 0, miss: 0 }, bike: { hit: 0, ok: 0, false: 0, miss: 0 }, qty: { more: 0, less: 0 },
    rainErr: [], rainFc: 0, rainObs: 0, tmaxErr: [], tminErr: [],
  }]));
  const bins = BINS.map(([lo, hi]) => ({ lo, hi, n: 0, rained: 0 }));
  // Punteggio di Brier: media di (probabilità − esito)², esito 1 se ha piovuto, 0 se no. Pesa lo
  // scarto: 90% senza pioggia costa 0,81, 30% senza pioggia 0,09.
  const brier = { sum: 0, n: 0, rained: 0, badHigh: 0, badLow: 0 };
  for (const d of full) {
    const obs = d.observed;
    for (const s of SLOTS) {
      const o = total(obs.rain, slotHours(s));
      for (const m of ALL_MODELS) {
        const fc = total(d.models[m.key]?.rain, slotHours(s));
        const res = outcome(fc, o, wet);
        if (res) models[m.key].counts[res]++;
        const q = qtyOff(fc, o, wet);
        if (q) models[m.key].qty[q]++;
      }
      const p = chance(d.ensemble, slotHours(s));
      if (p != null && o != null) {
        const b = bins.find((x) => p >= x.lo && p < x.hi);
        const rained = o >= wet - 1e-9;
        b.n++;
        if (rained) b.rained++;
        brier.sum += (p / 100 - (rained ? 1 : 0)) ** 2;
        brier.n++;
        if (rained) brier.rained++;
        if (!rained && p >= BAD_HIGH) brier.badHigh++;
        if (rained && p < BAD_LOW) brier.badLow++;
      }
    }
    // intervalli monitorati di quel giorno della settimana
    for (const w of dayWindows(watch, d.day)) {
      const o = total(obs.rain, windowHours(w));
      for (const m of ALL_MODELS) {
        const res = outcome(total(d.models[m.key]?.rain, windowHours(w)), o, wet);
        if (res) models[m.key].bike[res]++;
      }
    }
    for (const m of ALL_MODELS) {
      const f = d.models[m.key];
      if (!f) continue;
      const r = total(f.rain, dayHours());
      if (r != null && obs.total != null) {
        models[m.key].rainErr.push(r - obs.total);
        models[m.key].rainFc += r;
        models[m.key].rainObs += obs.total;
      }
      if (maxOf(f.temp) != null && obs.tMax != null) models[m.key].tmaxErr.push(maxOf(f.temp) - obs.tMax);
      if (minOf(f.temp) != null && obs.tMin != null) models[m.key].tminErr.push(minOf(f.temp) - obs.tMin);
    }
  }
  return { full: full.length, models, bins, brier };
}

// --- Rendering -----------------------------------------------------------------------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const absMean = (a) => mean(a.map(Math.abs));
const mm = (v) => (v == null ? '—' : `${fmt(v, 1)}`);
const when = (ms) => { const t = localDateTime(ms, TZ, 0); return `${t.day} alle ${t.time}`; };

function renderSummary(sum) {
  const el = $('#verify-summary');
  el.hidden = false;
  if (!sum.full) {
    el.innerHTML = `<h2>Riepilogo</h2><p class="info-note">Nessun giorno completo nel periodo: le misure della centralina e le previsioni si raccolgono da quando il server è attivo, quindi la verifica si riempie giorno dopo giorno.</p>`;
    return;
  }
  // i modelli di supporto solo se hanno almeno una fascia verificata (coprono ~48 ore)
  const counted = (m) => Object.values(sum.models[m.key].counts).some(Boolean);
  const shown = verifyModels().filter((m) => MODELS.includes(m) || counted(m));
  const row = (label, f, help = '') => `<tr><th scope="row">${label}${help ? `<small>${help}</small>` : ''}</th>${shown.map((m) => `<td>${f(sum.models[m.key])}</td>`).join('')}</tr>`;
  const pct = (s, c = s.counts) => {
    const n = c.hit + c.ok + c.false + c.miss;
    return n ? `<b>${Math.round((100 * (c.hit + c.ok)) / n)}%</b> <small class="opt">(${c.hit + c.ok} su ${n})</small>` : '—';
  };
  const err = (a, unit, dec) => (a.length ? `${fmt(absMean(a), dec)}${unit} <small>(in media ${fmtSigned(mean(a), dec)}${unit})</small>` : '—');
  el.innerHTML = `
    <h2>Riepilogo <span class="day-date">${sum.full} ${sum.full === 1 ? 'giorno completo' : 'giorni completi'}</span></h2>
    <div class="table-wrap"><table class="info-table vs-table">
      <thead><tr><th></th>${shown.map((m) => `<th><i class="dot-${m.key}"></i><span class="lg">${m.name}</span><span class="sm">${m.short}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${row('Fasce previste correttamente', pct, 'pioggia sì/no in ogni fascia di 6 ore')}
        ${!store.getWatch().windows.length ? '' : `<tr class="vs-bike">${(() => { const label = `${BIKE_ICON}${esc(store.getWatch().label)}: intervalli corretti`; return `<th scope="row">${label}<small>pioggia sì/no in ogni intervallo monitorato</small></th>${shown.map((m) => `<td>${pct(sum.models[m.key], sum.models[m.key].bike)}</td>`).join('')}`; })()}</tr>`}
        ${row('Pioggia prevista e caduta', (s) => s.counts.hit)}
        ${row(`${outcomeMark(OUTCOME.false, 18)}Falsi allarmi`, (s) => s.counts.false, 'pioggia prevista ma non caduta')}
        ${row(`${outcomeMark(OUTCOME.miss, 18)}Pioggia non prevista`, (s) => s.counts.miss)}
        ${row(`${outcomeMark(QTY.more, 18)}Quantità molto diversa`, (s) => (s.counts.hit ? `${s.qty.more + s.qty.less} <small class="opt q-split">(${outcomeMark(QTY.more, 15)} ${s.qty.more} · ${outcomeMark(QTY.less, 15)} ${s.qty.less})</small>` : '—'), `fasce con pioggia prevista e caduta, ma il doppio o la metà (scarto ≥ ${fmt(QTY_MM, 0)} mm)`)}
        ${row('Errore medio sulla pioggia del giorno', (s) => err(s.rainErr, ' mm', 1), 'in media: + troppa pioggia prevista, − troppo poca')}
        ${row('Pioggia prevista / caduta', (s) => (s.rainErr.length ? `${fmt(s.rainFc, 1)} / ${fmt(s.rainObs, 1)} mm` : '—'), 'somma dei giorni')}
        ${row('Errore medio sulla massima', (s) => err(s.tmaxErr, '°', 1), 'in media: + troppo caldo, − troppo fresco')}
        ${row('Errore medio sulla minima', (s) => err(s.tminErr, '°', 1))}
      </tbody>
    </table></div>
    <h3>Affidabilità della probabilità</h3>
    ${brierBlock(sum.brier)}
    <p class="info-note">Una probabilità ben calibrata del 30% dovrebbe vedere pioggia in circa 3 fasce su 10. <a href="info.html#affidabilita">Esempi</a></p>
    <table class="info-table vs-table">
      <thead><tr><th>Probabilità prevista</th><th>Fasce</th><th>Ha piovuto</th></tr></thead>
      <tbody>${sum.bins.map((b) => `<tr><th scope="row">${b.lo}–${Math.min(b.hi, 100)}%</th><td>${b.n}</td><td>${b.n ? `<b>${Math.round((100 * b.rained) / b.n)}%</b> <small>(${b.rained})</small>` : '—'}</td></tr>`).join('')}</tbody>
    </table>`;
}

// Punteggio di Brier delle fasce, confrontato con quello che si otterrebbe dando a ogni fascia
// la frequenza della pioggia nel periodo (r): r·(1 − r). "Meglio del X%" = 1 − Brier / riferimento.
const f2 = (v) => v.toFixed(2).replace('.', ','); // fmt() arriva a un decimale
function brierBlock(b) {
  if (!b.n) return '';
  const score = b.sum / b.n;
  const r = b.rained / b.n;
  const ref = r * (1 - r);
  const skill = ref > 0 ? Math.round(100 * (1 - score / ref)) : null;
  const vs = skill == null ? ''
    : skill > 0 ? `meglio del ${skill}% rispetto a dare sempre la frequenza del periodo (piove nel ${Math.round(100 * r)}% delle fasce: ${f2(ref)})`
    : `non meglio che dare sempre la frequenza del periodo (piove nel ${Math.round(100 * r)}% delle fasce: ${f2(ref)})`;
  return `<table class="info-table vs-table vs-brier"><tbody>
      <tr><th scope="row">Errore della probabilità<small>punteggio di Brier: 0 = perfetta, 0,25 = dire sempre 50%; ogni fascia pesa lo scarto al quadrato (90% senza pioggia costa 0,81, 30% senza pioggia 0,09). <a href="info.html#brier">Come si legge</a></small></th><td><b>${f2(score)}</b>${vs ? ` <small>${vs}</small>` : ''}</td></tr>
      <tr><th scope="row">Errori gravi<small>probabilità ≥ ${BAD_HIGH}% senza pioggia, o &lt; ${BAD_LOW}% con pioggia</small></th><td><b>${b.badHigh + b.badLow}</b> <small>su ${b.n} fasce (${b.badHigh} alta e asciutto · ${b.badLow} bassa e pioggia)</small></td></tr>
    </tbody></table>`;
}

// `judge` falso: si mostra solo il valore (es. il giorno di oggi non è ancora finito).
function cell(fc, obs, wet, judge = true) {
  const res = judge ? outcome(fc, obs, wet) : null;
  if (fc == null) return '<td class="na">—</td>';
  const o = res ? OUTCOME[res] : null;
  const q = judge ? QTY[qtyOff(fc, obs, wet)] : null;
  // nel tooltip esito, quantità e scarto previsto − caduto
  const title = o ? [o.label, q?.label, obs != null && fc !== obs ? `scarto ${fmtSigned(fc - obs, 1)} mm` : null].filter(Boolean).join(' · ') : '';
  // Quantità molto diversa: al posto della spunta la pioggia con la freccia su / giù.
  const shown = q || o;
  return `<td class="${o ? o.cls : ''}${q ? ' q-off' : ''}" title="${esc(title)}">${mm(fc)}${shown ? `<span class="o-mark" aria-hidden="true">${outcomeMark(shown)}</span>` : ''}</td>`;
}

function renderDay(d, wet, todayIso) {
  const obs = d.observed;
  // i modelli di supporto solo se c'è la loro previsione (coprono ~48 ore)
  const shown = verifyModels().filter((m) => MODELS.includes(m) || d.models[m.key]);
  const t = dayTitle(d.day, todayIso);
  const yesterday = new Date(Date.parse(`${todayIso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (d.day === yesterday) t.title = 'Ieri';
  const head = `<tr><th></th>${SLOTS.map((s) => `<th><span class="lg">${s.name}</span><span class="sm">${s.short}</span><small>${s.from}–${s.from + 6}</small></th>`).join('')}<th>Giorno</th></tr>`;
  const obsRow = `<tr class="obs"><th scope="row">Misurata</th>${SLOTS.map((s) => `<td>${mm(total(obs.rain, slotHours(s)))}</td>`).join('')}<td><b>${mm(obs.total)}</b></td></tr>`;
  const modelRows = shown.map((m) => {
    const f = d.models[m.key];
    if (!f) return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th><td class="na" colspan="5">previsione non disponibile</td></tr>`;
    return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th>${SLOTS.map((s) => cell(total(f.rain, slotHours(s)), total(obs.rain, slotHours(s)), wet)).join('')}${cell(total(f.rain, dayHours()), obs.total, wet, obs.complete)}</tr>`;
  }).join('');
  const popRow = d.ensemble
    ? `<tr class="pop"><th scope="row">Prob.</th>${SLOTS.map((s) => { const p = chance(d.ensemble, slotHours(s)); return `<td>${p == null ? '—' : `${p}%`}</td>`; }).join('')}<td>${(() => { const p = chance(d.ensemble, dayHours()); return p == null ? '—' : `${p}%`; })()}</td></tr>`
    : '';

  // Temperature: massima e minima previste (dalle ore) contro le misurate.
  const temps = shown.map((m) => {
    const f = d.models[m.key];
    if (!f) return '';
    const tx = maxOf(f.temp), tn = minOf(f.temp);
    // scarto dalla misura solo a giornata finita (oggi minima e massima non sono definitive)
    const diff = (a, b) => (obs.complete && a != null && b != null ? ` <small class="${Math.abs(a - b) >= 2 ? 'o-bad-t' : ''}">(${fmtSigned(a - b, 1)}°)</small>` : '');
    return `<li><i class="dot-${m.key}"></i>${m.name}: max ${fmt(tx, 1)}°${diff(tx, obs.tMax)} · min ${fmt(tn, 1)}°${diff(tn, obs.tMin)}</li>`;
  }).join('');

  // Intervalli monitorati del giorno della settimana (impostazioni dell'utente): tabella come
  // quella delle fasce, una colonna per intervallo, con esito ✓ ! ✗ per ogni modello.
  const watch = store.getWatch();
  const wins = dayWindows(watch, d.day);
  let bikeTable = '';
  if (wins.length) {
    const whead = `<tr><th></th>${wins.map((w) => `<th>${w.from}<small>${w.to}</small></th>`).join('')}</tr>`;
    const wobs = wins.map((w) => total(obs.rain, windowHours(w)));
    const wObsRow = `<tr class="obs"><th scope="row">Misurata</th>${wobs.map((o) => `<td>${mm(o)}</td>`).join('')}</tr>`;
    const wModelRows = shown.map((m) => {
      const f = d.models[m.key];
      if (!f) return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th><td class="na" colspan="${wins.length}">previsione non disponibile</td></tr>`;
      return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th>${wins.map((w, k) => cell(total(f.rain, windowHours(w)), wobs[k], wet)).join('')}</tr>`;
    }).join('');
    const wPopRow = d.ensemble
      ? `<tr class="pop"><th scope="row">Prob.</th>${wins.map((w) => { const p = chance(d.ensemble, windowHours(w).filter((x) => x.w > 0)); return `<td>${p == null ? '—' : `${p}%`}</td>`; }).join('')}</tr>`
      : '';
    bikeTable = `<div class="vd-bike">
      <h3>${BIKE_ICON}${esc(watch.label)}</h3>
      <div class="table-wrap"><table class="vt"><thead>${whead}</thead><tbody>${wObsRow}${wModelRows}${wPopRow}</tbody></table></div>
    </div>`;
  }

  const sources = [
    ...shown.map((m) => (d.models[m.key] ? `${m.name}: run delle ${when(d.models[m.key].runInit * 1000)}` : null)),
    d.ensemble ? `ensemble scaricato ${when(d.ensemble.issuedAt)}` : null,
  ].filter(Boolean).join(' · ');

  return `<section class="card day-card verify-day">
    <div class="card-head"><h2>${t.title} <span class="day-date">${t.date}</span></h2>${d.today ? '<span class="vd-badge">in corso</span>' : obs.complete ? '' : '<span class="vd-badge">misure incomplete</span>'}</div>
    <p class="vd-obs">Misurato: pioggia <b>${mm(obs.total)} mm</b> · min <b>${fmt(obs.tMin, 1)}°</b>${obs.tMinTime ? ` (${obs.tMinTime})` : ''} · max <b>${fmt(obs.tMax, 1)}°</b>${obs.tMaxTime ? ` (${obs.tMaxTime})` : ''}</p>
    <div class="table-wrap"><table class="vt"><thead>${head}</thead><tbody>${obsRow}${modelRows}${popRow}</tbody></table></div>
    ${temps ? `<ul class="vd-list">${temps}</ul>` : ''}
    ${bikeTable}
    ${sources ? `<p class="vd-src">Previsioni usate: ${sources}</p>` : ''}
  </section>`;
}

function render() {
  const { data } = state;
  const status = $('#verify-status');
  if (!data.days.length) {
    status.textContent = 'Nessuna misura nel periodo: la verifica si riempie giorno dopo giorno da quando il server è attivo.';
    $('#verify-summary').hidden = true;
    $('#verify-days').innerHTML = '';
    return;
  }
  status.hidden = true;
  renderSummary(summarize(data.days, data.wetMm));
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  $('#verify-days').innerHTML = data.days.map((d) => renderDay(d, data.wetMm, todayIso)).join('');
}

async function load() {
  const status = $('#verify-status');
  status.hidden = false;
  status.textContent = 'Caricamento…';
  $('#verify-note').textContent = state.lead === 1
    ? "Si verifica l'ultima previsione disponibile il giorno prima alle 23."
    : "Si verifica l'ultima previsione disponibile due giorni prima alle 23.";
  try {
    state.data = await getJSON(`api/verify?days=${state.days}&lead=${state.lead}`);
    render();
  } catch (err) {
    status.textContent = `Verifica non disponibile: ${err.message}.`;
  }
}

function syncControls() {
  for (const b of document.querySelectorAll('#lead-seg button')) b.setAttribute('aria-pressed', String(Number(b.dataset.lead) === state.lead));
  for (const b of document.querySelectorAll('#days-seg button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days));
}

$('#lead-seg').addEventListener('click', (e) => {
  const v = Number(e.target.closest('button')?.dataset.lead);
  if (!v || v === state.lead) return;
  state.lead = v;
  store.saveSettings({ verifyLead: v });
  syncControls();
  load();
});
$('#days-seg').addEventListener('click', (e) => {
  const v = Number(e.target.closest('button')?.dataset.days);
  if (!v || v === state.days) return;
  state.days = v;
  store.saveSettings({ verifyDays: v });
  syncControls();
  load();
});

// Legenda degli esiti nella scheda dei controlli (una voce per simbolo).
$('#verify-legend').innerHTML = [
  `<li class="o-good"><span class="o-mark">✓</span>previsione corretta</li>`,
  `<li class="o-bad"><span class="o-mark">${outcomeMark(OUTCOME.false)}</span>pioggia prevista ma non caduta</li>`,
  `<li class="o-mid"><span class="o-mark">${outcomeMark(OUTCOME.miss)}</span>pioggia caduta ma non prevista</li>`,
  `<li class="q-off"><span class="o-mark q-pair">${outcomeMark(QTY.more)}${outcomeMark(QTY.less)}</span>caduta molta più / meno pioggia del previsto</li>`,
].join('');

syncControls();
load();

// Ritorno alla pagina dalla cache del browser (bfcache), per esempio dopo le Impostazioni:
// se le scelte salvate sono cambiate le si applica e si ricarica.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  const s = store.getSettings();
  const lead = [1, 2].includes(s.verifyLead) ? s.verifyLead : 1;
  const days = [7, 30].includes(s.verifyDays) ? s.verifyDays : 7;
  if (lead === state.lead && days === state.days) return;
  Object.assign(state, { lead, days });
  syncControls();
  load();
});
