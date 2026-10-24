// Radar della Protezione Civile (calcolato dal server, vedi server/radar.py): pioggia vista
// adesso intorno a Faenza, movimento e stima dei prossimi 90 minuti (nowcasting).
// - riepilogo in `station.radar` (arriva con la misura della centralina, ogni 10 minuti):
//   riga del box Adesso (radarStatus) e verdetto delle ore di oggi (radarWindowRain);
// - sezione "Radar" collassabile: animazione dell'ultima ora più la proiezione (api/radar).
// La stima sposta la pioggia di adesso lungo il suo movimento: vede bene fronti e linee di
// rovesci, non i temporali che nascono sul posto.

import { getJSON } from './api.js';
import { esc, localDateTime } from './weather.js';

export const RADAR_STALE_MS = 30 * 60 * 1000; // oltre, il riepilogo non si usa
export const RADAR_LEAD_MIN = 90; // orizzonte della stima (riga del box Adesso)
export const RADAR_VERDICT_MIN = 60; // oltre, la stima è troppo incerta per cambiare il verdetto

// Intensità a parole (mm/h).
export const radarWords = (mmh) => (mmh < 2.5 ? 'debole' : mmh < 7.5 ? 'moderata' : 'forte');

// Passi della stima non ancora trascorsi: [{ at (ms), min, frac, mmh }], o null se il
// riepilogo manca o è vecchio. `frac` = quota della zona guardata con pioggia (la zona si
// allarga con i minuti: l'incertezza cresce).
export function radarSteps(r, now = Date.now()) {
  if (!r?.nowcast || now - r.time > RADAR_STALE_MS) return null;
  return r.nowcast.map((s) => ({ ...s, at: r.time + s.min * 60000 })).filter((s) => s.at >= now - 150000);
}

// Riepilogo per il box Adesso: { level: 'wet' | 'maybe' | 'near' | 'dry', text, tip } o null.
export function radarStatus(r, tz, off, now = Date.now()) {
  const steps = radarSteps(r, now);
  if (!steps) return null;
  const hhmm = (ms) => localDateTime(ms, tz, off).time;
  const wet = (s) => s.frac >= r.arriveFrac;
  const maybe = (s) => s.frac >= r.maybeFrac;
  const move = r.motion ? `La pioggia si muove verso ${r.motion.dir} a circa ${r.motion.kmh} km/h.` : '';
  const tip = `Radar della Protezione Civile, immagine delle ${hhmm(r.time)}. ${move}`.trim();
  const cur = steps[0];
  if (cur && wet(cur)) {
    const end = steps.find((s) => !maybe(s));
    return { level: 'wet', tip, text: `pioggia su Faenza (${radarWords(cur.mmh)})${end ? `, fino alle ~${hhmm(end.at)}` : ''}` };
  }
  const arr = steps.find(wet);
  if (arr) return { level: 'wet', tip, text: `pioggia in arrivo verso le ${hhmm(arr.at)} (${radarWords(arr.mmh)})` };
  const may = steps.find(maybe);
  if (may) return { level: 'maybe', tip, text: `possibile pioggia verso le ${hhmm(may.at)}` };
  if (r.nearest) {
    const where = r.nearest.km <= 3 ? 'vicinissima' : `a ${r.nearest.km} km a ${r.nearest.dir}`;
    return { level: 'near', tip, text: `pioggia ${where}${r.motion ? ', non diretta qui' : ''}` };
  }
  return { level: 'dry', tip, text: 'nessuna pioggia entro 50 km' };
}

// Primo passo della stima con pioggia (quota ≥ arriveFrac) tra `fromMs` e `toMs`, entro
// RADAR_VERDICT_MIN minuti da adesso, o null.
export function radarWindowRain(r, fromMs, toMs, now = Date.now()) {
  const steps = radarSteps(r, now);
  if (!steps) return null;
  const until = Math.min(toMs, now + RADAR_VERDICT_MIN * 60000);
  return steps.find((s) => s.frac >= r.arriveFrac && s.at >= fromMs - 150000 && s.at <= until) || null;
}

// --- Sezione "Radar" ---------------------------------------------------------------------

// userPaused: animazione fermata da chi guarda (pausa o cursore): le immagini nuove che arrivano
// con le letture della centralina non la fanno ripartire; si azzera chiudendo la sezione.
const player = { frames: [], idx: 0, timer: null, data: null, playing: false, userPaused: false };
const STEP_MS = 550; // durata di un fotogramma
const HOLD_MS = 1600; // pausa sull'ultima misura e alla fine

export const loadRadar = () => getJSON('api/radar');

function frameLabel(f, tz, off) {
  const t = localDateTime(f.t, tz, off).time;
  return f.min ? `${t} · stima +${f.min} min` : `${t} · misurato`;
}

// Costa, cerchi a 25 e 50 km e città sopra l'immagine. Le misure sono in pixel del ritaglio
// (1 px = 1 km): `u` le rende proporzionali al riquadro (scritte uguali qualunque sia VIEW_HALF).
function mapSvg(view) {
  const { size, cities, coast, borders = [] } = view;
  const c = (size - 1) / 2;
  const u = size / 161; // riferimento: riquadro di ±80 km, per cui sono state scelte le misure
  const line = (pts) => `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;
  const rings = [25, 50].map((r) => `<circle cx="${c + 0.5}" cy="${c + 0.5}" r="${r}"/>`).join('');
  const towns = cities.map((t, i) => (i === 0
    ? `<g class="rm-home"><circle cx="${t.x}" cy="${t.y}" r="${2.6 * u}"/><text x="${t.x + 4 * u}" y="${t.y + 1.8 * u}">${esc(t.name)}</text></g>`
    : `<g class="rm-town"><circle cx="${t.x}" cy="${t.y}" r="${1.4 * u}"/><text x="${t.x + (t.left ? -3 : 3) * u}" y="${t.y + 1.6 * u}"${t.left ? ' text-anchor="end"' : ''}>${esc(t.name)}</text></g>`)).join('');
  const label = (r) => `<text class="rm-scale" x="${c + 0.5 + r * 0.7071 + u}" y="${c + 0.5 - r * 0.7071 - u}">${r} km</text>`;
  return `<svg class="radar-map" viewBox="0 0 ${size} ${size}" style="--u:${u.toFixed(3)}" aria-hidden="true">
    <g class="rm-coast">${coast.map(line).join('')}</g>
    <g class="rm-border">${borders.map(line).join('')}</g>
    <g class="rm-rings">${rings}</g>
    ${towns}${label(25)}${label(50)}
  </svg>`.replace(/\s*\n\s*/g, '');
}

// Mare (sotto l'immagine radar, così la pioggia sul mare resta visibile): la costa chiusa
// verso il bordo destro, dove sta l'Adriatico, riempita con una tinta azzurra leggera.
function seaSvg(view) {
  const { size, coast } = view;
  const polys = coast.map((pts) => {
    const ring = [...pts, [size + 20, pts[pts.length - 1][1]], [size + 20, pts[0][1]]];
    return `<polygon points="${ring.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;
  }).join('');
  return `<svg class="radar-sea" viewBox="0 0 ${size} ${size}" aria-hidden="true">${polys}</svg>`;
}

function show(el, k, tz, off) {
  const f = player.frames[k];
  if (!f) return;
  player.idx = k;
  const img = el.querySelector('.radar-img');
  img.src = f.img;
  img.classList.toggle('fc', !!f.min);
  el.querySelector('.radar-badge').textContent = frameLabel(f, tz, off);
  el.querySelector('.radar-badge').classList.toggle('fc', !!f.min);
  const range = el.querySelector('.radar-range');
  range.value = String(k);
  range.setAttribute('aria-valuetext', frameLabel(f, tz, off));
}

export function stopRadar() {
  clearTimeout(player.timer);
  player.timer = null;
  player.playing = false;
  player.suspended = false;
  const b = document.querySelector('#radar-play');
  if (b) { b.setAttribute('aria-label', 'Avvia'); b.classList.remove('on'); }
}

// Sezione chiusa: animazione ferma e preferenza di pausa dimenticata.
export function closeRadar() {
  stopRadar();
  player.userPaused = false;
}

function play(el, tz, off) {
  stopRadar();
  player.playing = true;
  const b = el.querySelector('#radar-play');
  b.setAttribute('aria-label', 'Pausa');
  b.classList.add('on');
  const lastObs = player.frames.findLastIndex((f) => !f.min);
  player.ctx = [el, tz, off];
  const tick = () => {
    // App in background: animazione sospesa (niente timer), riprende al ritorno in primo piano.
    if (document.visibilityState !== 'visible') { player.timer = null; player.suspended = true; return; }
    const next = player.idx >= player.frames.length - 1 ? 0 : player.idx + 1;
    show(el, next, tz, off);
    const hold = next === lastObs || next === player.frames.length - 1;
    player.timer = setTimeout(tick, hold ? HOLD_MS : STEP_MS);
  };
  player.timer = setTimeout(tick, STEP_MS);
}

// Tratti della striscia "Su Faenza nei prossimi 90 minuti", in minuti da adesso: più è
// lontano il momento, più la stima è incerta (la zona guardata si allarga, la pioggia può
// cambiare strada o calare).
const OUTLOOK_STEP_MIN = 10;
const OUTLOOK_SPANS = [
  { until: 30, key: 'sure', label: 'affidabile', why: "prossima mezz'ora: la pioggia si vede già vicina" },
  { until: 60, key: 'mid', label: 'indicativa', why: "30–60 minuti: l'orario può spostarsi" },
  { until: Infinity, key: 'far', label: 'orientativa', why: "oltre un'ora: la pioggia può cambiare strada o calare" },
];

// "Su Faenza nei prossimi 90 minuti": una casella ogni 10 minuti, colorata come la mappa
// secondo l'intensità (a righe se la pioggia è solo possibile), divisa nei tre tratti di
// OUTLOOK_SPANS. La quota della zona con pioggia decide solo lo stato (asciutto / possibile /
// pioggia): non si disegna, perché una barra sembrava una probabilità.
function outlook(d, tz, off, now = Date.now()) {
  const steps = (radarSteps(d, now) || []).filter((s) => s.min % OUTLOOK_STEP_MIN === 0);
  if (steps.length < 2) return '';
  const hhmm = (ms) => localDateTime(ms, tz, off).time;
  const cell = (s) => {
    const wet = s.frac >= d.arriveFrac;
    const cls = wet ? `w${['debole', 'moderata', 'forte'].indexOf(radarWords(s.mmh)) + 1}` : s.frac >= d.maybeFrac ? 'maybe' : 'dry';
    const word = wet ? `pioggia ${radarWords(s.mmh)}` : cls === 'maybe' ? 'pioggia possibile' : 'asciutto';
    return { cls, text: `${hhmm(s.at)} ${word}` };
  };
  const groups = OUTLOOK_SPANS.map((sp, i) => {
    const from = i ? OUTLOOK_SPANS[i - 1].until : -Infinity;
    return { ...sp, steps: steps.filter((s) => { const m = (s.at - now) / 60000; return m >= from && m < sp.until; }) };
  }).filter((g) => g.steps.length);
  const last = steps[steps.length - 1];
  const strip = groups.map((g, i) => {
    const cells = g.steps.map(cell);
    const end = i === groups.length - 1 ? `<span>${hhmm(last.at)}</span>` : '';
    return `<div class="ro-span ro-${g.key}" style="--n:${g.steps.length}">
      <div class="ro-lab">${g.label}</div>
      <div class="ro-cells" role="img" aria-label="${esc(`Stima ${g.label}: ${cells.map((c) => c.text).join(', ')}`)}">${cells.map((c) => `<span class="ro-c ${c.cls}" title="${esc(c.text)}"></span>`).join('')}</div>
      <div class="ro-times"><span>${hhmm(g.steps[0].at)}</span>${end}</div>
    </div>`;
  }).join('');
  const key = groups.map((g) => `<dt>${g.label}</dt><dd>${g.why}</dd>`).join('');
  return `<div class="radar-outlook"><h3>Su Faenza nei prossimi 90 minuti</h3>
    <div class="ro-strip" style="grid-template-columns:${groups.map((g) => `${g.steps.length}fr`).join(' ')}">${strip}</div>
    <div class="ro-legend" aria-hidden="true"><span><i class="ro-c maybe"></i>possibile</span><span><i class="ro-c w1"></i>debole</span><span><i class="ro-c w2"></i>moderata</span><span><i class="ro-c w3"></i>forte</span></div>
    <dl class="ro-key">${key}</dl></div>`;
}

// Disegna la sezione con i dati di api/radar. `el` = corpo della sezione.
export function renderRadar(el, d, tz, off) {
  stopRadar();
  player.data = d;
  player.frames = [...d.frames, ...d.forecast];
  if (!player.frames.length) {
    el.innerHTML = '<p class="muted">Immagini radar non disponibili.</p>';
    return;
  }
  // Precarica le immagini (pochi KB ciascuna; quelle già viste arrivano dalla cache).
  for (const f of player.frames) new Image().src = f.img;
  const lastObs = player.frames.findLastIndex((f) => !f.min);
  // Confine tra immagini lette e stime sulla linea del tempo: a metà tra l'ultima immagine
  // letta e la prima stima, in frazione del cursore (null se non ci sono stime).
  const max = player.frames.length - 1;
  const split = lastObs >= 0 && lastObs < max ? (lastObs + 0.5) / max : null;
  const legend = d.legend.map((x) => `<span><i style="background:${x.color}"></i>${String(x.from).replace('.', ',')}</span>`).join('');
  const st = radarStatus(d, tz, off);
  el.innerHTML = `
    <div class="radar-layout">
      <div class="radar-view" style="--n:${d.view.size}">
        ${seaSvg(d.view)}
        <img class="radar-img" alt="Immagine radar della pioggia intorno a Faenza" width="${d.view.size}" height="${d.view.size}">
        ${mapSvg(d.view)}
        <span class="radar-badge"></span>
        ${d.motion ? `<span class="radar-move" title="Movimento della pioggia"><svg viewBox="0 0 24 24" aria-hidden="true" style="transform: rotate(${d.motion.deg}deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>${d.motion.kmh} km/h</span>` : ''}
      </div>
      <div class="radar-side">
        ${st ? `<p class="radar-status lv-${st.level}">${esc(st.text.charAt(0).toUpperCase() + st.text.slice(1))}${d.motion ? `<small>La pioggia si muove verso ${d.motion.dir} a circa ${d.motion.kmh} km/h.</small>` : ''}</p>` : ''}
        <div class="radar-ctrl">
          <button type="button" id="radar-play" class="icon-btn" aria-label="Avvia">
            <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>
          </button>
          <div class="radar-tl"${split != null ? ` style="--f:${split.toFixed(4)}"` : ''}>
            <input class="radar-range" type="range" min="0" max="${player.frames.length - 1}" step="1" aria-label="Momento dell'immagine">
            ${split != null ? '<span class="radar-tl-mark" aria-hidden="true"></span><span class="radar-tl-lab" aria-hidden="true"><span>radar</span><span>stima</span></span>' : ''}
          </div>
        </div>
        ${outlook(d, tz, off)}
        <div class="radar-legend" aria-label="Intensità in mm/h">${legend}<span class="muted">mm/h</span></div>
        <p class="radar-note muted">Le immagini dopo le ${localDateTime(player.frames[lastObs].t, tz, off).time} (con la scritta "stima") sono una <strong>stima</strong>: la pioggia di adesso spostata lungo il suo movimento. Non vede i temporali che nascono sul posto. In grigio le zone non coperte dal radar; il tratto-punto è il confine di regione. Immagini: Dipartimento della Protezione Civile (CC BY-SA 4.0); confini ISTAT (CC BY).</p>
      </div>
    </div>`;
  show(el, lastObs, tz, off);
  el.querySelector('#radar-play').addEventListener('click', () => {
    player.userPaused = player.playing;
    if (player.playing) stopRadar();
    else play(el, tz, off);
  });
  el.querySelector('.radar-range').addEventListener('input', (e) => {
    player.userPaused = true;
    stopRadar();
    show(el, Number(e.target.value), tz, off);
  });
  if (!player.userPaused && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) play(el, tz, off);
}

export const radarTime = () => player.data?.time ?? null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && player.suspended && player.playing && player.ctx?.[0].isConnected) {
    play(...player.ctx);
  }
});
