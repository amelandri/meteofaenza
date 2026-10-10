// Radar della Protezione Civile (calcolato dal server, vedi server/radar.py): pioggia vista
// adesso intorno a Faenza, movimento e stima dei prossimi 90 minuti (nowcasting).
// - riepilogo in `station.radar` (arriva con la misura della centralina, ogni 10 minuti):
//   riga del box Adesso (radarStatus) e tragitti di oggi (radarWindowRain);
// - sezione "Radar" collassabile: animazione dell'ultima ora più la proiezione (api/radar).
// La stima sposta la pioggia di adesso lungo il suo movimento: vede bene fronti e linee di
// rovesci, non i temporali che nascono sul posto.

import { getJSON } from './api.js';
import { esc, localDateTime } from './weather.js';

export const RADAR_STALE_MS = 30 * 60 * 1000; // oltre, il riepilogo non si usa
export const RADAR_LEAD_MIN = 90; // orizzonte della stima (riga del box Adesso)
export const RADAR_BIKE_MIN = 60; // oltre, la stima è troppo incerta per cambiare il verdetto dei tragitti

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
// RADAR_BIKE_MIN minuti da adesso, o null.
export function radarWindowRain(r, fromMs, toMs, now = Date.now()) {
  const steps = radarSteps(r, now);
  if (!steps) return null;
  const until = Math.min(toMs, now + RADAR_BIKE_MIN * 60000);
  return steps.find((s) => s.frac >= r.arriveFrac && s.at >= fromMs - 150000 && s.at <= until) || null;
}

// --- Sezione "Radar" ---------------------------------------------------------------------

const player = { frames: [], idx: 0, timer: null, data: null, playing: false };
const STEP_MS = 550; // durata di un fotogramma
const HOLD_MS = 1600; // pausa sull'ultima misura e alla fine

export const loadRadar = () => getJSON('api/radar');

function frameLabel(f, tz, off) {
  const t = localDateTime(f.t, tz, off).time;
  return f.min ? `${t} · stima +${f.min} min` : `${t} · misurato`;
}

function mapSvg(view) {
  const { size, cities, coast } = view;
  const c = (size - 1) / 2;
  const line = (pts) => `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;
  const rings = [25, 50].map((r) => `<circle cx="${c + 0.5}" cy="${c + 0.5}" r="${r}"/>`).join('');
  const towns = cities.map((t, i) => (i === 0
    ? `<g class="rm-home"><circle cx="${t.x}" cy="${t.y}" r="2.6"/><text x="${t.x + 4}" y="${t.y + 1.8}">${esc(t.name)}</text></g>`
    : `<g class="rm-town"><circle cx="${t.x}" cy="${t.y}" r="1.4"/><text x="${t.x + 3}" y="${t.y + 1.6}">${esc(t.name)}</text></g>`)).join('');
  return `<svg class="radar-map" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <g class="rm-coast">${coast.map(line).join('')}</g>
    <g class="rm-rings">${rings}</g>
    ${towns}
    <text class="rm-scale" x="${c + 0.5 + 25 * 0.7071 + 1}" y="${c + 0.5 - 25 * 0.7071 - 1}">25 km</text>
  </svg>`.replace(/\s*\n\s*/g, '');
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
  el.querySelector('.radar-range').value = String(k);
}

export function stopRadar() {
  clearTimeout(player.timer);
  player.timer = null;
  player.playing = false;
  const b = document.querySelector('#radar-play');
  if (b) { b.setAttribute('aria-label', 'Avvia'); b.classList.remove('on'); }
}

function play(el, tz, off) {
  stopRadar();
  player.playing = true;
  const b = el.querySelector('#radar-play');
  b.setAttribute('aria-label', 'Pausa');
  b.classList.add('on');
  const lastObs = player.frames.findLastIndex((f) => !f.min);
  const tick = () => {
    if (document.visibilityState !== 'visible') { player.timer = setTimeout(tick, 2000); return; }
    const next = player.idx >= player.frames.length - 1 ? 0 : player.idx + 1;
    show(el, next, tz, off);
    const hold = next === lastObs || next === player.frames.length - 1;
    player.timer = setTimeout(tick, hold ? HOLD_MS : STEP_MS);
  };
  player.timer = setTimeout(tick, STEP_MS);
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
  const legend = d.legend.map((x) => `<span><i style="background:${x.color}"></i>${String(x.from).replace('.', ',')}</span>`).join('');
  el.innerHTML = `
    <div class="radar-view" style="--n:${d.view.size}">
      <img class="radar-img" alt="Immagine radar della pioggia intorno a Faenza" width="${d.view.size}" height="${d.view.size}">
      ${mapSvg(d.view)}
      <span class="radar-badge"></span>
      ${d.motion ? `<span class="radar-move" title="Movimento della pioggia"><svg viewBox="0 0 24 24" aria-hidden="true" style="transform: rotate(${d.motion.deg}deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>${d.motion.kmh} km/h</span>` : ''}
    </div>
    <div class="radar-ctrl">
      <button type="button" id="radar-play" class="icon-btn" aria-label="Avvia">
        <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>
      </button>
      <input class="radar-range" type="range" min="0" max="${player.frames.length - 1}" step="1" aria-label="Momento dell'immagine">
    </div>
    <div class="radar-legend" aria-label="Intensità in mm/h">${legend}<span class="muted">mm/h</span></div>
    <p class="radar-note muted">Le immagini dopo le ${localDateTime(player.frames[lastObs].t, tz, off).time} (con la scritta "stima") sono una <strong>stima</strong>: la pioggia di adesso spostata lungo il suo movimento. Non vede i temporali che nascono sul posto. In grigio le zone non coperte dal radar. Immagini: Dipartimento della Protezione Civile (CC BY-SA 4.0).</p>`;
  show(el, lastObs, tz, off);
  el.querySelector('#radar-play').addEventListener('click', () => (player.playing ? stopRadar() : play(el, tz, off)));
  el.querySelector('.radar-range').addEventListener('input', (e) => { stopRadar(); show(el, Number(e.target.value), tz, off); });
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) play(el, tz, off);
}

export const radarTime = () => player.data?.time ?? null;
