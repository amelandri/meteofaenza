// Pagina Verifica: per i giorni passati confronta pioggia e temperature previste (la sera
// prima o due giorni prima) con quelle misurate dalla centralina. I dati arrivano dal server
// (api/verify, vedi server/verify.py); qui si calcolano fasce, intervalli monitorati ed esiti.
// Convenzione oraria come nell'app: l'indice h (0…23) è la pioggia dell'ora (h, h+1].

import { MODELS, SUPPORT_MODELS, getJSON } from './api.js';
import * as store from './storage.js';
import { fmt, fmtSigned, esc, dayTitle, localDateTime } from './weather.js';

const SLOTS = [
  { from: 0, name: 'Notte', short: 'Notte' },
  { from: 6, name: 'Mattina', short: 'Matt.' },
  { from: 12, name: 'Pomeriggio', short: 'Pom.' },
  { from: 18, name: 'Sera', short: 'Sera' },
];
const TZ = 'Europe/Rome';
// Esito di una previsione di pioggia (soglia: wetMm del server, 0,2 mm come nell'app).
const OUTCOME = {
  hit: { label: 'pioggia prevista e caduta', mark: '✓', cls: 'o-good' },
  ok: { label: 'nessuna pioggia, come previsto', mark: '✓', cls: 'o-good' },
  false: { label: 'pioggia prevista ma non caduta (falso allarme)', mark: '!', cls: 'o-mid' },
  miss: { label: 'pioggia caduta ma non prevista', mark: '✗', cls: 'o-bad' },
};
// Fasce di probabilità per l'affidabilità dell'ensemble.
const BINS = [[0, 20], [20, 50], [50, 80], [80, 101]];

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

function outcome(fc, obs, wet) {
  if (fc == null || obs == null) return null;
  const f = fc >= wet - 1e-9, o = obs >= wet - 1e-9;
  return f ? (o ? 'hit' : 'false') : (o ? 'miss' : 'ok');
}

const maxOf = (a) => { const v = (a || []).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
const minOf = (a) => { const v = (a || []).filter((x) => x != null); return v.length ? Math.min(...v) : null; };

// Riepilogo sui giorni completi: esiti delle fasce, errori di pioggia e temperature per
// modello, affidabilità della probabilità.
function summarize(days, wet) {
  const full = days.filter((d) => d.observed.complete && !d.today);
  const models = Object.fromEntries(ALL_MODELS.map((m) => [m.key, {
    counts: { hit: 0, ok: 0, false: 0, miss: 0 }, rainErr: [], rainFc: 0, rainObs: 0, tmaxErr: [], tminErr: [],
  }]));
  const bins = BINS.map(([lo, hi]) => ({ lo, hi, n: 0, rained: 0 }));
  for (const d of full) {
    const obs = d.observed;
    for (const s of SLOTS) {
      const o = total(obs.rain, slotHours(s));
      for (const m of ALL_MODELS) {
        const res = outcome(total(d.models[m.key]?.rain, slotHours(s)), o, wet);
        if (res) models[m.key].counts[res]++;
      }
      const p = chance(d.ensemble, slotHours(s));
      if (p != null && o != null) {
        const b = bins.find((x) => p >= x.lo && p < x.hi);
        b.n++;
        if (o >= wet - 1e-9) b.rained++;
      }
    }
    for (const m of ALL_MODELS) {
      const f = d.models[m.key];
      if (!f) continue;
      const r = total(f.rain, dayHours());
      if (r != null && obs.total != null) {
        models[m.key].rainErr.push(Math.abs(r - obs.total));
        models[m.key].rainFc += r;
        models[m.key].rainObs += obs.total;
      }
      if (maxOf(f.temp) != null && obs.tMax != null) models[m.key].tmaxErr.push(maxOf(f.temp) - obs.tMax);
      if (minOf(f.temp) != null && obs.tMin != null) models[m.key].tminErr.push(minOf(f.temp) - obs.tMin);
    }
  }
  return { full: full.length, models, bins };
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
  const pct = (s) => {
    const c = s.counts, n = c.hit + c.ok + c.false + c.miss;
    return n ? `<b>${Math.round((100 * (c.hit + c.ok)) / n)}%</b> <small class="opt">(${c.hit + c.ok} su ${n})</small>` : '—';
  };
  const err = (a, unit, dec) => (a.length ? `${fmt(absMean(a), dec)}${unit} <small>(in media ${fmtSigned(mean(a), dec)}${unit})</small>` : '—');
  el.innerHTML = `
    <h2>Riepilogo <span class="day-date">${sum.full} ${sum.full === 1 ? 'giorno completo' : 'giorni completi'}</span></h2>
    <div class="table-wrap"><table class="info-table vs-table">
      <thead><tr><th></th>${shown.map((m) => `<th><i class="dot-${m.key}"></i><span class="lg">${m.name}</span><span class="sm">${m.short}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${row('Fasce previste correttamente', pct, 'pioggia sì/no in ogni fascia di 6 ore')}
        ${row('Pioggia prevista e caduta', (s) => s.counts.hit)}
        ${row('Falsi allarmi', (s) => s.counts.false, 'pioggia prevista ma non caduta')}
        ${row('Pioggia non prevista', (s) => s.counts.miss)}
        ${row('Errore medio sulla pioggia del giorno', (s) => (s.rainErr.length ? `${fmt(mean(s.rainErr), 1)} mm` : '—'))}
        ${row('Pioggia prevista / caduta', (s) => (s.rainErr.length ? `${fmt(s.rainFc, 1)} / ${fmt(s.rainObs, 1)} mm` : '—'), 'somma dei giorni')}
        ${row('Errore medio sulla massima', (s) => err(s.tmaxErr, '°', 1), 'in media: + troppo caldo, − troppo fresco')}
        ${row('Errore medio sulla minima', (s) => err(s.tminErr, '°', 1))}
      </tbody>
    </table></div>
    <h3>Affidabilità della probabilità</h3>
    <p class="info-note">Una probabilità ben calibrata del 30% dovrebbe vedere pioggia in circa 3 fasce su 10.</p>
    <table class="info-table vs-table">
      <thead><tr><th>Probabilità prevista</th><th>Fasce</th><th>Ha piovuto</th></tr></thead>
      <tbody>${sum.bins.map((b) => `<tr><th scope="row">${b.lo}–${Math.min(b.hi, 100)}%</th><td>${b.n}</td><td>${b.n ? `<b>${Math.round((100 * b.rained) / b.n)}%</b> <small>(${b.rained})</small>` : '—'}</td></tr>`).join('')}</tbody>
    </table>`;
}

// `judge` falso: si mostra solo il valore (es. il giorno di oggi non è ancora finito).
function cell(fc, obs, wet, judge = true) {
  const res = judge ? outcome(fc, obs, wet) : null;
  if (fc == null) return '<td class="na">—</td>';
  const o = res ? OUTCOME[res] : null;
  return `<td class="${o ? o.cls : ''}" title="${o ? esc(o.label) : ''}">${mm(fc)}${o ? `<span class="o-mark" aria-hidden="true">${o.mark}</span>` : ''}</td>`;
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

  // Intervalli monitorati del giorno della settimana (impostazioni dell'utente).
  const wd = new Date(`${d.day}T12:00:00Z`).getUTCDay();
  const watch = store.getWatch();
  const wins = watch.windows.filter((w) => w.days.includes(wd)).map((w) => {
    const hrs = windowHours(w);
    const o = total(obs.rain, hrs);
    const fcs = shown.map((m) => {
      const fc = total(d.models[m.key]?.rain, hrs);
      const res = outcome(fc, o, wet);
      return `<span class="${res ? OUTCOME[res].cls : ''}" title="${res ? esc(OUTCOME[res].label) : ''}">${m.short} ${mm(fc)}${res ? ` ${OUTCOME[res].mark}` : ''}</span>`;
    }).join(' · ');
    const p = chance(d.ensemble, hrs.filter((x) => x.w > 0));
    return `<li><b>${w.from}–${w.to}</b>: misurata ${mm(o)} mm · ${fcs}${p != null ? ` · prob. ${p}%` : ''}</li>`;
  }).join('');

  const sources = [
    ...shown.map((m) => (d.models[m.key] ? `${m.name}: run delle ${when(d.models[m.key].runInit * 1000)}` : null)),
    d.ensemble ? `ensemble scaricato ${when(d.ensemble.issuedAt)}` : null,
  ].filter(Boolean).join(' · ');

  return `<section class="card day-card verify-day">
    <div class="card-head"><h2>${t.title} <span class="day-date">${t.date}</span></h2>${d.today ? '<span class="vd-badge">in corso</span>' : obs.complete ? '' : '<span class="vd-badge">misure incomplete</span>'}</div>
    <p class="vd-obs">Misurato: pioggia <b>${mm(obs.total)} mm</b> · min <b>${fmt(obs.tMin, 1)}°</b>${obs.tMinTime ? ` (${obs.tMinTime})` : ''} · max <b>${fmt(obs.tMax, 1)}°</b>${obs.tMaxTime ? ` (${obs.tMaxTime})` : ''}</p>
    <div class="table-wrap"><table class="vt"><thead>${head}</thead><tbody>${obsRow}${modelRows}${popRow}</tbody></table></div>
    ${temps ? `<ul class="vd-list">${temps}</ul>` : ''}
    ${wins ? `<h3>${esc(watch.label)}</h3><ul class="vd-list">${wins}</ul>` : ''}
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
  $('#verify-days').innerHTML = `<p class="vd-legend">${Object.values(OUTCOME).filter((o, i, a) => a.findIndex((x) => x.mark === o.mark) === i)
    .map((o) => `<span class="${o.cls}"><span class="o-mark">${o.mark}</span> ${o.mark === '✓' ? 'previsione corretta' : o.label}</span>`).join('')}</p>`
    + data.days.map((d) => renderDay(d, data.wetMm, todayIso)).join('');
}

async function load() {
  const status = $('#verify-status');
  status.hidden = false;
  status.textContent = 'Caricamento…';
  $('#verify-note').textContent = state.lead === 1
    ? "Si verifica l'ultima previsione disponibile prima della mezzanotte del giorno (la sera prima)."
    : "Si verifica l'ultima previsione disponibile prima della mezzanotte del giorno precedente (due giorni prima).";
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

syncControls();
load();
