// Livelli dei fiumi Lamone e Marzeno (idrometri ARPAE, scaricati dal server: vedi
// server/rivers.py). Sezione "Fiumi" collassabile: chiusa mostra il livello a Faenza di ogni
// fiume nell'intestazione; aperta un riquadro per fiume con le stazioni nel verso della
// corrente (prima quella a monte), livello, tendenza, barra con le soglie e grafico di 48 ore.

import { getJSON } from './api.js';
import { fmt, esc, localDateTime } from './weather.js';

export const loadRivers = () => getJSON('api/rivers');

export const RIVERS_STALE_MS = 3 * 3600 * 1000; // oltre, i dati sono "non aggiornati"
const TREND_MH = 0.03; // m/h oltre cui il livello è "in salita" / "in calo"
const LEVEL_LABEL = ['Livelli normali', 'Soglia 1 superata', 'Soglia 2 superata', 'Soglia 3 superata'];

const lv = (n) => (n ? ` l${n}` : '');
// Metri con due decimali (centimetri): fmt() di weather.js arriva a un decimale.
const NF2 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const m2 = (v) => NF2.format(v);

function trend(x) {
  if (x.trend == null) return '';
  if (x.trend >= TREND_MH) return `<small class="up">↑ in salita +${m2(x.trend)} m/h</small>`;
  if (x.trend <= -TREND_MH) return `<small>↓ in calo ${m2(x.trend)} m/h</small>`;
  return '<small>→ stabile</small>';
}

// Barra da 0 a soglia 3 + 15%, con le tre soglie come tacche colorate.
function bar(x) {
  const max = x.s[2] * 1.15;
  const p = (v) => Math.min(100, Math.max(0, (v / max) * 100));
  return `<div class="rv-bar" aria-hidden="true"><span class="rv-track"></span><span class="rv-fill${lv(x.level)}" style="width:${Math.max(1.5, p(x.v))}%"></span>${
    x.s.map((s, i) => `<i class="rv-tick t${i + 1}" style="left:calc(${p(s)}% - 1px)"></i><span class="rv-lab" style="left:${p(s)}%">${fmt(s, 1)}</span>`).join('')}</div>`;
}

// Grafico delle ultime 48 ore: scala sui dati (almeno 0,5 m, per non ingigantire i
// centimetri), soglie tratteggiate quando rientrano nella scala.
function spark(x) {
  const d = x.series;
  if (d.length < 2) return '';
  const W = 300, H = 46;
  const vs = d.map((p) => p[1]);
  const lo = Math.min(0, ...vs);
  const hi = Math.max(Math.max(...vs) * 1.15, lo + 0.5);
  const t0 = d[0][0], t1 = d[d.length - 1][0];
  const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const Y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  const pts = d.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const thr = x.s.map((s, i) => (s <= hi ? `<line class="t${i + 1}" x1="0" x2="${W}" y1="${Y(s).toFixed(1)}" y2="${Y(s).toFixed(1)}"/>` : '')).join('');
  return `<svg class="rv-spark${lv(x.level)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${thr}<polygon points="0,${H} ${pts} ${W},${H}"/><polyline points="${pts}"/></svg>`;
}

function station(x, tz, off) {
  const tip = `${x.name}: ${m2(x.v)} m alle ${localDateTime(x.t, tz, off).time} · soglie ${x.s.map((s) => fmt(s, 1)).join(' / ')} m`;
  return `<div class="rv-st" title="${esc(tip)}">
    <div class="rv-name">${esc(x.name)}<small>${esc(x.where)}</small></div>
    <div class="rv-lvl"><b>${m2(x.v)}<span>m</span></b>${trend(x)}</div>
    ${bar(x)}${spark(x)}
  </div>`;
}

function river(r, tz, off) {
  const who = r.stations.filter((x) => x.level === r.level).map((x) => x.name).join(' e ');
  const state = r.level ? `${LEVEL_LABEL[r.level]} a ${who}` : LEVEL_LABEL[0];
  return `<article class="rv">
    <div class="rv-head"><h3>${esc(r.name)}</h3><span class="rv-state${lv(r.level)}">${esc(state)}</span></div>
    ${r.stations.map((x) => station(x, tz, off)).join('<div class="rv-flow">verso valle</div>')}
  </article>`;
}

// Livello a Faenza (ultima stazione) di ogni fiume, per l'intestazione della sezione chiusa.
export function riversSummary(d) {
  if (!d?.rivers?.length) return '';
  return d.rivers.map((r) => {
    const x = r.stations[r.stations.length - 1];
    return `<span class="rv-chip${lv(r.level)}"><i></i>${esc(r.name)} ${m2(x.v)} m</span>`;
  }).join('');
}

export function renderRivers(el, d, tz, off) {
  if (!d?.rivers?.length) {
    el.innerHTML = '<p class="muted">Livelli dei fiumi non disponibili.</p>';
    return;
  }
  const at = localDateTime(d.time, tz, off);
  const stale = Date.now() - d.time > RIVERS_STALE_MS;
  el.innerHTML = `<div class="rv-grid">${d.rivers.map((r) => river(r, tz, off)).join('')}</div>
    <p class="rv-note muted">${stale ? '<b class="obs-stale">Dati non aggiornati.</b> ' : ''}Livello dell'acqua in metri, ultimo dato delle ${at.time}${stale ? ` del ${at.day}` : ''} (ogni 15 minuti, pubblicato con 30–60 minuti di ritardo). Le tacche colorate sono le soglie di allerta 1, 2 e 3; il grafico copre le ultime 48 ore. Dati: ARPAE Emilia-Romagna – Allerta Meteo.</p>`;
}
