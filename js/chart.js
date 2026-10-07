// Grafico SVG minimale (linee e barre raggruppate) senza dipendenze esterne,
// con fasce giornaliere, linea "adesso" e tooltip al passaggio del puntatore/dito.

import { parts, dayShort, fmt } from './weather.js';

const NS = 'http://www.w3.org/2000/svg';

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

export function renderChart(el, opts) {
  const {
    times, series, unit = '', nowIso = null,
    yFloor = null, yCeil = null, minSpan = 4, tooltip,
  } = opts;

  el.innerHTML = '';
  const n = times.length;
  if (!n) return;

  const W = Math.max(280, el.clientWidth);
  const H = W < 520 ? 220 : 270;
  const pad = { l: 40, r: 10, t: 24, b: 26 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const step = plotW / n;
  const x = (i) => pad.l + step * (i + 0.5);

  // --- Scala Y -----------------------------------------------------------------
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (lo === Infinity) { lo = 0; hi = 1; }
  if (yFloor != null) lo = Math.min(lo, yFloor);
  if (yCeil != null) hi = Math.max(hi, yCeil);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = yFloor != null && mid - minSpan / 2 < yFloor ? yFloor : mid - minSpan / 2;
    hi = lo + minSpan;
  }
  const tickStep = niceStep(hi - lo, 4);
  let y0 = Math.floor(lo / tickStep) * tickStep;
  if (yFloor != null) y0 = Math.max(y0, yFloor);
  const y1 = Math.ceil(hi / tickStep) * tickStep;
  const y = (v) => pad.t + plotH * (1 - (v - y0) / (y1 - y0 || 1));

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.ariaLabel || 'Grafico');

  let html = '';

  // --- Fasce giornaliere ---------------------------------------------------------
  const hours = times.map((t) => parts(t).hh);
  let start = 0, band = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || hours[i] === 0) {
      const bx = pad.l + step * start, bw = step * (i - start);
      if (band % 2) html += `<rect class="band" x="${bx}" y="${pad.t}" width="${bw}" height="${plotH}"/>`;
      if (bw > 44) html += `<text class="day-label" x="${bx + bw / 2}" y="${pad.t - 9}" text-anchor="middle">${dayShort(times[start])}</text>`;
      start = i; band++;
    }
  }

  // --- Griglia orizzontale -------------------------------------------------------
  for (let v = y0; v <= y1 + 1e-9; v += tickStep) {
    const yy = y(v).toFixed(1);
    html += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`;
    html += `<text class="tick" x="${pad.l - 6}" y="${yy}" dy="0.32em" text-anchor="end">${fmt(v, tickStep < 1 ? 1 : 0)}</text>`;
  }
  html += `<text class="tick unit" x="${pad.l - 6}" y="${pad.t - 9}" text-anchor="end">${unit}</text>`;

  // --- Etichette orarie ----------------------------------------------------------
  const every = [1, 2, 3, 6, 12, 24].find((k) => step * k >= 34) || 24;
  for (let i = 0; i < n; i++) {
    if (hours[i] % every === 0) {
      html += `<line class="xtick" x1="${x(i)}" x2="${x(i)}" y1="${pad.t + plotH}" y2="${pad.t + plotH + 4}"/>`;
      html += `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${String(hours[i]).padStart(2, '0')}</text>`;
    }
  }

  // --- Barre ---------------------------------------------------------------------
  const bars = series.filter((s) => s.type === 'bar');
  if (bars.length) {
    const bw = Math.max(1.5, Math.min(9, (step * 0.84) / bars.length));
    const base = y(Math.max(y0, 0));
    bars.forEach((s, k) => {
      const off = (k - (bars.length - 1) / 2) * bw;
      s.values.forEach((v, i) => {
        if (v == null || v <= 0) return;
        const top = y(v);
        html += `<rect class="bar ${s.cls}" x="${(x(i) + off - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 0.6).toFixed(1)}" height="${Math.max(1, base - top).toFixed(1)}" rx="1"/>`;
      });
    });
  }

  // --- Linee ---------------------------------------------------------------------
  for (const s of series.filter((s) => s.type !== 'bar')) {
    let d = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d) html += `<path class="line ${s.cls}${s.dash ? ' dash' : ''}" d="${d}"/>`;
  }

  // --- Adesso --------------------------------------------------------------------
  const nowIdx = nowIso ? times.indexOf(nowIso) : -1;
  if (nowIdx >= 0) {
    const nx = x(nowIdx);
    html += `<line class="now" x1="${nx}" x2="${nx}" y1="${pad.t}" y2="${pad.t + plotH}"/>`;
  }

  html += `<g class="cursor" visibility="hidden"><line class="cursor-line" y1="${pad.t}" y2="${pad.t + plotH}"/></g>`;
  html += `<rect class="hit" x="${pad.l}" y="0" width="${plotW}" height="${H}"/>`;
  svg.innerHTML = html;
  el.appendChild(svg);

  // --- Interazione ---------------------------------------------------------------
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  el.appendChild(tip);

  const cursor = svg.querySelector('.cursor');
  const cursorLine = svg.querySelector('.cursor-line');
  const lineSeries = series.filter((s) => s.type !== 'bar');
  const dots = lineSeries.map((s) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '3.5');
    c.setAttribute('class', `dot ${s.cls}`);
    cursor.appendChild(c);
    return c;
  });

  const hit = svg.querySelector('.hit');
  let lastIdx = -1;
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.min(n - 1, Math.max(0, Math.floor((px - pad.l) / step)));
    if (i === lastIdx && !tip.hidden) return;
    lastIdx = i;
    const cx = x(i);
    cursor.setAttribute('visibility', 'visible');
    cursorLine.setAttribute('x1', cx);
    cursorLine.setAttribute('x2', cx);
    lineSeries.forEach((s, k) => {
      const v = s.values[i];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', y(v)); }
    });
    tip.innerHTML = tooltip ? tooltip(i) : `${times[i]}`;
    tip.hidden = false;
    const scale = rect.width / W;
    const tw = tip.offsetWidth;
    let left = cx * scale + 12;
    if (left + tw > rect.width - 4) left = cx * scale - tw - 12;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${pad.t * scale}px`;
  };
  const hide = () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; lastIdx = -1; };

  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);
}

// Testo di supporto per i valori nel tooltip.
export const tipValue = (v, decimals, unit) => (v == null ? '<span class="muted">n.d.</span>' : `${fmt(v, decimals)}${unit ? ` ${unit}` : ''}`);
