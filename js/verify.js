// Pagina Verifica: per i giorni passati confronta pioggia e temperature previste (il giorno
// prima o due giorni prima, alle 23) con quelle misurate dalla centralina. I dati arrivano dal server
// (api/verify, vedi server/verify.py) con gli esiti già calcolati per fasce e giorno (salvati
// sul server per i giorni conclusi); qui si fanno solo il riepilogo del periodo e le tabelle.

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
// Esito di una previsione di pioggia (calcolato dal server con soglia wetMm, 0,2 mm come nell'app).
// `icon`: esito disegnato con rainMarkIcon() (pioggia + X rossa / punto esclamativo); senza,
// il segno di spunta.
const OUTCOME = {
  hit: { label: 'pioggia prevista e caduta', mark: '✓', cls: 'o-good' },
  ok: { label: 'nessuna pioggia, come previsto', mark: '✓', cls: 'o-good' },
  false: { label: 'pioggia prevista ma non caduta (falso allarme)', icon: 'x', cls: 'o-bad' },
  miss: { label: 'pioggia caduta ma non prevista', icon: '!', cls: 'o-mid' },
};
// Quantità molto diversa (solo se pioggia prevista e caduta): uno almeno il doppio
// dell'altro e scarto di almeno QTY_MM (QTY_RATIO / QTY_MM di server/verify.py).
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
  days: store.PREF_VALUES.verifyDays.includes(settings.verifyDays) ? settings.verifyDays : 7,
  data: null,
};
const shownModels = () => {
  const only = MODELS.find((m) => m.key === store.getSettings().models);
  return only ? [only] : MODELS;
};
// Nella verifica anche i modelli di supporto (ICON-D2, AROME), che votano nel verdetto
// orario: qui si vede se aiutano davvero.
const verifyModels = () => [...shownModels(), ...SUPPORT_MODELS];
const ALL_MODELS = [...MODELS, ...SUPPORT_MODELS];

// --- Riepilogo -------------------------------------------------------------------------

// Riepilogo sui giorni completi: conteggi degli esiti delle fasce, errori di pioggia e
// temperature per modello, affidabilità della probabilità.
function summarize(days) {
  const full = days.filter((d) => d.observed.complete && !d.today);
  const models = Object.fromEntries(ALL_MODELS.map((m) => [m.key, {
    counts: { hit: 0, ok: 0, false: 0, miss: 0 }, qty: { more: 0, less: 0 },
    rainErr: [], rainFc: 0, rainObs: 0, tmaxErr: [], tminErr: [],
  }]));
  const bins = BINS.map(([lo, hi]) => ({ lo, hi, n: 0, rained: 0 }));
  // Punteggio di Brier: media di (probabilità − esito)², esito 1 se ha piovuto, 0 se no. Pesa lo
  // scarto: 90% senza pioggia costa 0,81, 30% senza pioggia 0,09.
  const brier = { sum: 0, n: 0, rained: 0, badHigh: 0, badLow: 0 };
  for (const d of full) {
    const obs = d.observed;
    SLOTS.forEach((s, k) => {
      const o = obs.slots[k];
      for (const m of ALL_MODELS) {
        const c = d.models[m.key]?.slots[k];
        if (c?.res) models[m.key].counts[c.res]++;
        if (c?.qty) models[m.key].qty[c.qty]++;
      }
      const p = d.ensemble?.slots[k];
      if (p != null && o != null) {
        const b = bins.find((x) => p >= x.lo && p < x.hi);
        const rained = o >= d.wetMm - 1e-9;
        b.n++;
        if (rained) b.rained++;
        brier.sum += (p / 100 - (rained ? 1 : 0)) ** 2;
        brier.n++;
        if (rained) brier.rained++;
        if (!rained && p >= BAD_HIGH) brier.badHigh++;
        if (rained && p < BAD_LOW) brier.badLow++;
      }
    });
    for (const m of ALL_MODELS) {
      const f = d.models[m.key];
      if (!f) continue;
      const r = f.day.fc;
      if (r != null && obs.total != null) {
        models[m.key].rainErr.push(r - obs.total);
        models[m.key].rainFc += r;
        models[m.key].rainObs += obs.total;
      }
      if (f.tMax != null && obs.tMax != null) models[m.key].tmaxErr.push(f.tMax - obs.tMax);
      if (f.tMin != null && obs.tMin != null) models[m.key].tminErr.push(f.tMin - obs.tMin);
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
  const rel = $('#verify-reliability');
  if (!sum.full) {
    el.innerHTML = `<h2>Riepilogo</h2><p class="info-note">Nessun giorno completo nel periodo: le misure della centralina e le previsioni si raccolgono da quando il server è attivo, quindi la verifica si riempie giorno dopo giorno.</p>`;
    rel.hidden = true;
    return;
  }
  rel.hidden = !sum.brier.n;
  rel.innerHTML = `<h2>Affidabilità della probabilità</h2>${reliabilityBlock(sum.brier, sum.bins)}`;
  // i modelli di supporto solo se hanno almeno una fascia verificata (coprono ~48 ore)
  const counted = (m) => Object.values(sum.models[m.key].counts).some(Boolean);
  const shown = verifyModels().filter((m) => MODELS.includes(m) || counted(m));
  const row = (label, f, help = '') => `<tr><th scope="row">${label}${help ? `<small>${help}</small>` : ''}</th>${shown.map((m) => `<td>${f(sum.models[m.key])}</td>`).join('')}</tr>`;
  const pct = (s) => {
    const c = s.counts;
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
        ${row('Pioggia prevista e caduta', (s) => s.counts.hit)}
        ${row(`${outcomeMark(OUTCOME.false, 18)}Falsi allarmi`, (s) => s.counts.false, 'pioggia prevista ma non caduta')}
        ${row(`${outcomeMark(OUTCOME.miss, 18)}Pioggia non prevista`, (s) => s.counts.miss)}
        ${row(`${outcomeMark(QTY.more, 18)}Quantità molto diversa`, (s) => (s.counts.hit ? `${s.qty.more + s.qty.less} <small class="opt q-split">(${outcomeMark(QTY.more, 15)} ${s.qty.more} · ${outcomeMark(QTY.less, 15)} ${s.qty.less})</small>` : '—'), `fasce con pioggia prevista e caduta, ma il doppio o la metà (scarto ≥ ${fmt(QTY_MM, 0)} mm)`)}
        ${row('Errore medio sulla pioggia del giorno', (s) => err(s.rainErr, ' mm', 1), 'in media: + troppa pioggia prevista, − troppo poca')}
        ${row('Pioggia prevista / caduta', (s) => (s.rainErr.length ? `${fmt(s.rainFc, 1)} / ${fmt(s.rainObs, 1)} mm` : '—'), 'somma dei giorni')}
        ${row('Errore medio sulla massima', (s) => err(s.tmaxErr, '°', 1), 'in media: + troppo caldo, − troppo fresco')}
        ${row('Errore medio sulla minima', (s) => err(s.tminErr, '°', 1))}
      </tbody>
    </table></div>`;
}

// Giudizio di un gruppo della tabella per probabilità: la quota di fasce con pioggia cade nel
// gruppo (con BIN_SLACK punti di tolleranza), sotto (si annuncia troppa pioggia) o sopra.
const BIN_SLACK = 5;
const BIN_MIN = 5; // meno fasce: troppo poche per giudicare
function binState(b) {
  if (b.n < BIN_MIN) return 'few';
  const q = (100 * b.rained) / b.n;
  if (q < b.lo - BIN_SLACK) return 'less';
  if (q > Math.min(b.hi, 100) + BIN_SLACK) return 'more';
  return 'ok';
}
const BIN_READING = {
  few: 'troppo poche fasce per giudicare', less: 'piove meno di quanto annunciato',
  more: 'piove più di quanto annunciato', ok: 'in linea con quanto annunciato',
};

// Quanto ci si può fidare della probabilità, in un colpo d'occhio: una lancetta su tre zone
// (scarsa / discreta / buona), il giudizio in una frase e tre numeri chiave; numeri, spiegazioni
// e tabella per probabilità in "Mostra i dettagli" (chiuso).
// Errore medio = radice del punteggio di Brier (media di (probabilità − esito)²), in punti
// percentuali: annunciare 30% e non piove sono 30 punti. Si confronta con un pronostico fisso che
// dà a ogni fascia la frequenza della pioggia nel periodo (r): punteggio r·(1 − r). Il giudizio
// viene dal miglioramento (skill = 1 − Brier / riferimento): buona da VERDICT_GOOD, discreta
// sopra 0, scarsa altrimenti; con meno di VERDICT_MIN_RAIN fasce piovose nessun giudizio.
const f2 = (v) => v.toFixed(2).replace('.', ','); // fmt() arriva a un decimale
const VERDICT_MIN_RAIN = 4;
const VERDICT_GOOD = 20;
const GAUGE_MIN = -25, GAUGE_MAX = 50; // estremi della lancetta (miglioramento in %)

function reliabilityJudge(b) {
  const score = b.sum / b.n, r = b.rained / b.n, ref = r * (1 - r);
  const skill = ref > 0 ? Math.round(100 * (1 - score / ref)) : null;
  const pts = (v) => Math.round(100 * Math.sqrt(v));
  const app = pts(score), fixed = pts(ref), fixedPct = Math.round(100 * r);
  let level, word, text;
  if (b.rained < VERDICT_MIN_RAIN || skill == null) {
    level = 'few';
    word = 'Pochi dati';
    text = skill == null && b.rained
      ? `Ha piovuto in tutte le ${b.n} fasce del periodo: non c'è niente da distinguere.`
      : `Nel periodo ha piovuto in ${b.rained} ${b.rained === 1 ? 'fascia' : 'fasce'} su ${b.n}: troppo poche per un giudizio. Meglio scegliere un periodo più lungo.`;
  } else if (skill >= VERDICT_GOOD) {
    level = 'good'; word = 'Buona';
    text = 'La probabilità distingue bene le fasce con pioggia da quelle asciutte.';
  } else if (skill > 0) {
    level = 'mid'; word = 'Discreta';
    text = 'La probabilità sbaglia un po\' meno di un pronostico fisso, ma non di molto.';
  } else {
    level = 'bad'; word = 'Scarsa';
    text = `Nel periodo annunciare sempre il ${fixedPct}% (quanto è piovuto davvero) avrebbe sbagliato meno.`;
  }
  return { score, skill, app, fixed, fixedPct, level, word, text };
}

// Lancetta su un semicerchio a tre zone; posizione = miglioramento sul pronostico fisso tra
// GAUGE_MIN e GAUGE_MAX. Con pochi dati arco grigio e niente lancetta.
function gaugeSvg(j) {
  const R = 70, cx = 85, cy = 82;
  const f = (skill) => Math.max(0, Math.min(1, (skill - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)));
  const pt = (t, r = R) => [cx - r * Math.cos(Math.PI * t), cy - r * Math.sin(Math.PI * t)].map((v) => v.toFixed(1));
  const arc = (t0, t1, cls) => {
    const [x0, y0] = pt(t0), [x1, y1] = pt(t1);
    return `<path class="g-arc ${cls}" d="M${x0} ${y0}A${R} ${R} 0 0 1 ${x1} ${y1}"/>`;
  };
  const zero = f(0), good = f(VERDICT_GOOD);
  const needle = j.level === 'few' ? '' : (() => {
    const [x, y] = pt(f(j.skill), R - 18);
    return `<line class="g-needle" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/><circle class="g-hub" cx="${cx}" cy="${cy}" r="5"/>`;
  })();
  return `<svg class="vs-gauge${j.level === 'few' ? ' few' : ''}" viewBox="0 0 170 104" role="img" aria-label="Affidabilità della probabilità: ${j.word.toLowerCase()}">
    ${arc(0, zero - 0.01, 'bad')}${arc(zero + 0.01, good - 0.01, 'mid')}${arc(good + 0.01, 1, 'good')}${needle}
    <text class="g-label" x="${cx}" y="101" text-anchor="middle">${j.level === 'few' ? '?' : j.word}</text></svg>`;
}

function reliabilityBlock(b, bins) {
  if (!b.n) return '';
  const j = reliabilityJudge(b);
  const states = bins.map(binState);
  const judged = states.filter((s) => s !== 'few');
  const inLine = judged.filter((s) => s === 'ok').length;
  const chip = `<span class="vs-chip ${j.level}">${j.level === 'few' ? j.word : `Affidabilità ${j.word.toLowerCase()}`}</span>`;
  const kpis = `<div class="vs-kpis">
      <div><span>Errore medio</span><b>${j.app} punti</b><small>pronostico fisso: ${j.fixed}</small></div>
      <div><span>Errori gravi</span><b>${b.badHigh + b.badLow}</b><small>su ${b.n} fasce</small></div>
      <div><span>In linea</span><b>${judged.length ? `${inLine} su ${judged.length}` : '—'}</b><small>gruppi di probabilità</small></div>
    </div>`;
  const rows = bins.map((x, k) => `<tr><th scope="row">${x.lo}–${Math.min(x.hi, 100)}%</th><td>${x.n}</td><td>${x.n ? `<b>${Math.round((100 * x.rained) / x.n)}%</b> <small>(${x.rained} su ${x.n})</small>` : '—'}</td><td><small>${x.n ? BIN_READING[states[k]] : ''}</small></td></tr>`).join('');
  return `<div class="vs-rel">
      <div class="vs-rel-top">${gaugeSvg(j)}<div class="vs-rel-text">${chip}<p>${j.text}</p></div></div>
      ${kpis}
      <details class="vs-rel-more"><summary>Mostra i dettagli</summary>
        <table class="info-table vs-table vs-brier"><tbody>
          <tr><th scope="row">Errore medio della probabilità<small>quanto si allontana in media da quello che è successo: annunciare 30% e non piove sono 30 punti, 90% e non piove 90. <a href="info.html#brier">Come si calcola</a></small></th><td><b>${j.app} punti</b> <small>(punteggio di Brier ${f2(j.score)})</small></td></tr>
          <tr><th scope="row">Con un pronostico fisso<small>annunciare in ogni fascia il ${j.fixedPct}%, cioè quanto è piovuto davvero nel periodo</small></th><td><b>${j.fixed} punti</b>${j.skill != null ? ` <small>(la probabilità fa ${j.skill >= 0 ? `meglio del ${j.skill}%` : `peggio del ${-j.skill}%`})</small>` : ''}</td></tr>
          <tr><th scope="row">Errori gravi<small>almeno ${BAD_HIGH}% e non è piovuto, o meno del ${BAD_LOW}% ed è piovuto</small></th><td><b>${b.badHigh + b.badLow}</b> <small>su ${b.n} fasce: ${b.badHigh} pioggia annunciata e non venuta, ${b.badLow} pioggia arrivata senza preavviso</small></td></tr>
        </tbody></table>
        <p class="info-note">La probabilità è affidabile se, nelle fasce in cui annunciava per esempio il 30%, ha piovuto davvero circa 3 volte su 10. Qui le fasce sono raggruppate per probabilità annunciata ("In linea" conta i gruppi con almeno ${BIN_MIN} fasce). <a href="info.html#affidabilita">Esempi</a></p>
        <table class="info-table vs-table">
          <thead><tr><th>Probabilità annunciata</th><th>Fasce</th><th>Ha piovuto</th><th>Come si legge</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    </div>`;
}

// Cella di una previsione: `c` = { fc, res, qty } dal server (res null = non giudicata, per
// esempio il totale di oggi), `obs` = pioggia misurata per lo scarto nel tooltip.
function cell(c, obs) {
  if (c?.fc == null) return '<td class="na">—</td>';
  const o = c.res ? OUTCOME[c.res] : null;
  const q = c.res ? QTY[c.qty] : null;
  // nel tooltip esito, quantità e scarto previsto − caduto
  const title = o ? [o.label, q?.label, obs != null && c.fc !== obs ? `scarto ${fmtSigned(c.fc - obs, 1)} mm` : null].filter(Boolean).join(' · ') : '';
  // Quantità molto diversa: al posto della spunta la pioggia con la freccia su / giù.
  const shown = q || o;
  return `<td class="${o ? o.cls : ''}${q ? ' q-off' : ''}" title="${esc(title)}">${mm(c.fc)}${shown ? `<span class="o-mark" aria-hidden="true">${outcomeMark(shown)}</span>` : ''}</td>`;
}

function renderDay(d, todayIso) {
  const obs = d.observed;
  // i modelli di supporto solo se c'è la loro previsione (coprono ~48 ore)
  const shown = verifyModels().filter((m) => MODELS.includes(m) || d.models[m.key]);
  const t = dayTitle(d.day, todayIso);
  const yesterday = new Date(Date.parse(`${todayIso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (d.day === yesterday) t.title = 'Ieri';
  const head = `<tr><th></th>${SLOTS.map((s) => `<th><span class="lg">${s.name}</span><span class="sm">${s.short}</span><small>${s.from}–${s.from + 6}</small></th>`).join('')}<th>Giorno</th></tr>`;
  const obsRow = `<tr class="obs"><th scope="row">Misurata</th>${obs.slots.map((o) => `<td>${mm(o)}</td>`).join('')}<td><b>${mm(obs.total)}</b></td></tr>`;
  const modelRows = shown.map((m) => {
    const f = d.models[m.key];
    if (!f) return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th><td class="na" colspan="5">previsione non disponibile</td></tr>`;
    return `<tr><th scope="row"><i class="dot-${m.key}"></i>${m.short}</th>${f.slots.map((c, k) => cell(c, obs.slots[k])).join('')}${cell(f.day, obs.total)}</tr>`;
  }).join('');
  const pct = (p) => `<td>${p == null ? '—' : `${p}%`}</td>`;
  const popRow = d.ensemble
    ? `<tr class="pop"><th scope="row">Prob.</th>${d.ensemble.slots.map(pct).join('')}${pct(d.ensemble.day)}</tr>`
    : '';

  // Temperature: massima e minima previste (dalle ore) contro le misurate.
  const temps = shown.map((m) => {
    const f = d.models[m.key];
    if (!f) return '';
    const tx = f.tMax, tn = f.tMin;
    // scarto dalla misura solo a giornata finita (oggi minima e massima non sono definitive)
    const diff = (a, b) => (obs.complete && a != null && b != null ? ` <small class="${Math.abs(a - b) >= 2 ? 'o-bad-t' : ''}">(${fmtSigned(a - b, 1)}°)</small>` : '');
    return `<li><i class="dot-${m.key}"></i>${m.name}: max ${fmt(tx, 1)}°${diff(tx, obs.tMax)} · min ${fmt(tn, 1)}°${diff(tn, obs.tMin)}</li>`;
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
    ${sources ? `<p class="vd-src">Previsioni usate: ${sources}</p>` : ''}
  </section>`;
}

const DAYS_SHOWN = 14; // giorni mostrati in "Giorno per giorno"

function render() {
  const { data } = state;
  const status = $('#verify-status');
  if (!data.days.length) {
    status.textContent = 'Nessuna misura nel periodo: la verifica si riempie giorno dopo giorno da quando il server è attivo.';
    status.hidden = false;
    $('#verify-top').hidden = true;
    $('#verify-days-sec').hidden = true;
    return;
  }
  status.hidden = true;
  $('#verify-top').hidden = false;
  $('#verify-days-sec').hidden = false;
  for (const d of data.days) d.wetMm = data.wetMm;
  renderSummary(summarize(data.days));
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  // Giorno per giorno solo gli ultimi DAYS_SHOWN giorni: il riepilogo usa tutto il periodo
  const shown = data.days.slice(0, DAYS_SHOWN);
  $('#verify-days-note').textContent = `Pioggia misurata e prevista in ogni fascia di 6 ore, dal giorno più recente${data.days.length > DAYS_SHOWN ? `: gli ultimi ${DAYS_SHOWN} giorni (il riepilogo comprende tutto il periodo)` : ''}.`;
  $('#verify-days').innerHTML = shown.map((d) => renderDay(d, todayIso)).join('');
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

// Legenda degli esiti sotto l'affidabilità: una riga di voci brevi, la spiegazione nel title.
$('#verify-legend').innerHTML = [
  `<li class="o-good" title="previsione corretta"><span class="o-mark">✓</span>corretta</li>`,
  `<li class="o-bad" title="pioggia prevista ma non caduta"><span class="o-mark">${outcomeMark(OUTCOME.false)}</span>falso allarme</li>`,
  `<li class="o-mid" title="pioggia caduta ma non prevista"><span class="o-mark">${outcomeMark(OUTCOME.miss)}</span>non prevista</li>`,
  `<li class="q-off" title="caduta molta più / meno pioggia del previsto"><span class="o-mark q-pair">${outcomeMark(QTY.more)}${outcomeMark(QTY.less)}</span>più / meno pioggia</li>`,
].join('');

syncControls();
load();

// Preferenze dal server (storage.js): all'avvio la copia locale, poi il riallineamento; al
// ritorno dalla cache del browser (bfcache), per esempio dopo le Impostazioni, si rilegge la
// copia e si risincronizza. Se sono cambiate le scelte le si applica (nuovo caricamento per
// anticipo e periodo, nuovo disegno per i modelli mostrati).
let shownKey = store.getSettings().models;
function applyStoredSettings() {
  const s = store.getSettings();
  const lead = [1, 2].includes(s.verifyLead) ? s.verifyLead : 1;
  const days = store.PREF_VALUES.verifyDays.includes(s.verifyDays) ? s.verifyDays : 7;
  if (lead !== state.lead || days !== state.days) {
    Object.assign(state, { lead, days });
    syncControls();
    load();
  } else if (s.models !== shownKey && state.data) {
    render();
  }
  shownKey = s.models;
}
window.addEventListener('pageshow', (e) => { if (e.persisted) { applyStoredSettings(); store.syncSettings(); } });
window.addEventListener('meteo-settings', applyStoredSettings);
store.syncSettings();
