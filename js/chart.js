// Grafico SVG minimale (linee e barre raggruppate) senza dipendenze esterne,
// con fasce giornaliere, linea "adesso" e tooltip al passaggio del puntatore/dito.
// Opzionale una seconda scala a destra (`y2`, es. probabilità 0–100%): le serie con
// `axis: 'y2'` sono disegnate come area + linea dietro le altre.
// Opzionale `daylight` ([{ rise, set }] in ora locale "YYYY-MM-DDTHH:MM", un elemento per
// giorno): barra giorno/notte sopra l'area del grafico, sotto i nomi dei giorni, con un
// pallino (e tooltip) per ogni alba e tramonto.

import { parts, dayShort, fmt, sunEventIcon } from './weather.js';

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
    yFloor = null, yCeil = null, minSpan = 4, tooltip, y2: right = null, daylight = null,
  } = opts;
  const dayBar = !!daylight?.length;

  el.innerHTML = '';
  const n = times.length;
  if (!n) return;

  const W = Math.max(280, el.clientWidth);
  const H = W < 520 ? 220 : 270;
  const pad = { l: 40, r: right ? 36 : 10, t: dayBar ? 36 : 24, b: 26 }; // in alto spazio per la barra giorno/notte
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const step = plotW / n;
  const x = (i) => pad.l + step * (i + 0.5);

  // --- Scala Y -----------------------------------------------------------------
  const main = series.filter((s) => s.axis !== 'y2');
  const second = series.filter((s) => s.axis === 'y2');
  let lo = Infinity, hi = -Infinity;
  for (const s of main) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
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
  // Scala destra: da 0 a right.max (es. 100%)
  const yR = (v) => pad.t + plotH * (1 - v / (right?.max || 100));
  const yOf = (s) => (s.axis === 'y2' ? yR : y);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.ariaLabel || 'Grafico');

  let html = '';

  // --- Fasce giornaliere ---------------------------------------------------------
  // Il cambio di giorno è alla mezzanotte, cioè sul punto delle 00:00 (x(i), centro della
  // colonna di quell'ora), non sul bordo sinistro della colonna (che sarebbe le 23:30).
  const hours = times.map((t) => parts(t).hh);
  const edge = (i) => (i <= 0 ? pad.l : i >= n ? pad.l + plotW : x(i));
  let start = 0, band = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || hours[i] === 0) {
      const bx = edge(start), bw = edge(i) - bx;
      if (band % 2) html += `<rect class="band" x="${bx}" y="${pad.t}" width="${bw}" height="${plotH}"/>`;
      if (bw > 44) html += `<text class="day-label" x="${bx + bw / 2}" y="${pad.t - (dayBar ? 17 : 9)}" text-anchor="middle">${dayShort(times[start])}</text>`;
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
  if (right) {
    // Asse destro proprio (colore della serie): linea verticale, tacche ed etichette, così
    // la scala della probabilità si distingue da quella dei mm (la griglia è dei mm).
    const ax = W - pad.r;
    html += `<line class="axis y2" x1="${ax}" x2="${ax}" y1="${pad.t}" y2="${pad.t + plotH}"/>`;
    for (const v of right.ticks || [0, 25, 50, 75, 100]) {
      const yy = yR(v).toFixed(1);
      html += `<line class="axis y2" x1="${ax}" x2="${ax + 4}" y1="${yy}" y2="${yy}"/>`;
      html += `<text class="tick y2" x="${ax + 7}" y="${yy}" dy="0.32em" text-anchor="start">${v}</text>`;
    }
    html += `<text class="tick unit y2" x="${ax + 7}" y="${pad.t - 9}" text-anchor="start">${right.unit || ''}</text>`;
  }

  // --- Aree della scala destra (dietro barre e linee) ----------------------------
  for (const s of second) {
    let seg = [];
    const flush = () => {
      if (seg.length) {
        const top = seg.map(([i, v]) => `${x(i).toFixed(1)} ${yR(v).toFixed(1)}`).join(' L');
        const base = yR(0).toFixed(1);
        html += `<path class="area ${s.cls}" d="M${x(seg[0][0]).toFixed(1)} ${base} L${top} L${x(seg[seg.length - 1][0]).toFixed(1)} ${base} Z"/>`;
      }
      seg = [];
    };
    s.values.forEach((v, i) => (v == null ? flush() : seg.push([i, v])));
    flush();
  }

  // --- Barra giorno/notte ---------------------------------------------------------
  // Stessi colori della linea del tempo di oggi (--day-* in style.css): notte grigia, giorno
  // alba → mezzogiorno → tramonto, con passaggi sfumati in un'ora (= step px). Il gradiente è
  // definito su tutti i giorni (anche fuori dal grafico), così ai bordi il colore è giusto.
  if (dayBar) {
    const m0 = Date.parse(`${times[0]}:00Z`) / 60000;
    const xm = (iso) => pad.l + step * ((Date.parse(`${iso}:00Z`) / 60000 - m0) / 60 + 0.5);
    const pts = daylight.flatMap(({ rise, set }) => {
      const xr = xm(rise), xs = xm(set);
      return [[xr - step, 'night'], [xr, 'dawn'], [(xr + xs) / 2, 'noon'], [xs, 'dusk'], [xs + step, 'night']];
    });
    const gx1 = pts[0][0], gx2 = pts[pts.length - 1][0];
    const stops = pts.map(([xx, c]) => `<stop offset="${((xx - gx1) / (gx2 - gx1 || 1)).toFixed(4)}" style="stop-color: var(--day-${c})"/>`).join('');
    html += `<defs><linearGradient id="day-night" gradientUnits="userSpaceOnUse" x1="${gx1.toFixed(1)}" x2="${gx2.toFixed(1)}" y1="0" y2="0">${stops}</linearGradient></defs>`;
    const barY = pad.t - 9; // sopra l'area del grafico, sotto i nomi dei giorni
    html += `<rect class="day-bar" x="${pad.l}" y="${barY}" width="${plotW}" height="5" rx="2.5" fill="url(#day-night)"/>`;
    // Marker di alba e tramonto: un pallino grigio sulla barra, con bordo dello sfondo per
    // staccarlo dai colori della barra. Al passaggio del mouse o al tocco compare sotto il
    // pallino la pillola di alba/tramonto con la punta a fumetto (come nella card di oggi,
    // vedi "Tooltip di alba e tramonto" più sotto); il cerchio trasparente più grande allarga
    // l'area sensibile. La barra è fuori dall'area attiva del grafico (.hit), quindi il
    // puntatore qui non mostra i dati delle ore.
    const marker = (iso, kind) => {
      const cx = xm(iso);
      if (cx < pad.l || cx > W - pad.r) return '';
      const cy = barY + 2.5;
      const label = `${kind === 'rise' ? 'Alba' : 'Tramonto'} ${iso.slice(11, 16)}`;
      return `<g class="sun-mark-g" data-kind="${kind}" data-time="${iso.slice(11, 16)}" data-x="${cx.toFixed(1)}" data-y="${cy}" aria-label="${label}">`
        + `<circle class="sun-hit" cx="${cx.toFixed(1)}" cy="${cy}" r="9"/>`
        + `<circle class="sun-mark ${kind}" cx="${cx.toFixed(1)}" cy="${cy}" r="3.5"/></g>`;
    };
    for (const { rise, set } of daylight) html += marker(rise, 'rise') + marker(set, 'set');
  }

  // --- Etichette orarie ----------------------------------------------------------
  const every = [1, 2, 3, 6, 12, 24].find((k) => step * k >= 34) || 24;
  for (let i = 0; i < n; i++) {
    if (hours[i] % every === 0) {
      html += `<line class="xtick" x1="${x(i)}" x2="${x(i)}" y1="${pad.t + plotH}" y2="${pad.t + plotH + 4}"/>`;
      html += `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${String(hours[i]).padStart(2, '0')}</text>`;
    }
  }

  // --- Barre ---------------------------------------------------------------------
  const bars = main.filter((s) => s.type === 'bar');
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
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${yOf(s)(v).toFixed(1)}`;
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
  // Area attiva (puntatore e tooltip dei dati): solo l'area del grafico, non le etichette
  // né la barra giorno/notte sopra.
  html += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/>`;
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
      if (v != null) { dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', yOf(s)(v)); }
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

  // --- Tooltip di alba e tramonto ---------------------------------------------------
  // La pillola della card di oggi (icona + orario, punta a fumetto verso l'alto) sotto il
  // pallino. Mouse: compare al passaggio e sparisce uscendo. Tocco: compare al tocco e si
  // chiude da sola dopo qualche secondo o con un secondo tocco sullo stesso pallino.
  const sunTip = document.createElement('span');
  sunTip.className = 'sun-pill tip-up chart-sun-tip';
  sunTip.hidden = true;
  el.appendChild(sunTip);
  let sunTimer, sunFor = null;
  const hideSun = () => { clearTimeout(sunTimer); sunTip.hidden = true; sunFor = null; };
  const showSun = (g) => {
    const scale = svg.getBoundingClientRect().width / W;
    const { kind, time } = g.dataset;
    sunTip.className = `sun-pill tip-up chart-sun-tip ${kind}`;
    sunTip.innerHTML = `${sunEventIcon(kind, 15)}${time}`;
    sunTip.hidden = false;
    // Sotto il pallino, centrata; la punta resta sul pallino anche se la pillola è spinta
    // dentro i bordi del grafico (--tip-dx).
    const cx = Number(g.dataset.x) * scale, w = sunTip.offsetWidth;
    const left = Math.min(Math.max(cx, w / 2 + 2), el.clientWidth - w / 2 - 2);
    sunTip.style.left = `${left}px`;
    sunTip.style.top = `${(Number(g.dataset.y) + 9) * scale + 6}px`;
    sunTip.style.setProperty('--tip-dx', `${cx - left}px`);
    sunFor = g;
  };
  for (const g of svg.querySelectorAll('.sun-mark-g')) {
    g.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showSun(g); });
    g.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideSun(); });
    g.addEventListener('click', (e) => {
      if (e.pointerType === 'mouse' || (e.detail && matchMedia('(hover: hover)').matches)) return;
      if (sunFor === g && !sunTip.hidden) { hideSun(); return; }
      showSun(g);
      clearTimeout(sunTimer);
      sunTimer = setTimeout(hideSun, 4000);
    });
  }
}

// Testo di supporto per i valori nel tooltip.
export const tipValue = (v, decimals, unit) => (v == null ? '<span class="muted">n.d.</span>' : `${fmt(v, decimals)}${unit ? ` ${unit}` : ''}`);
