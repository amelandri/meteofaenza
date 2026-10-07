// Codici meteo WMO, icone SVG inline e funzioni di formattazione.

const CODES = {
  0: ['Sereno', 'clear'],
  1: ['Poco nuvoloso', 'mostly-clear'],
  2: ['Parzialmente nuvoloso', 'partly'],
  3: ['Coperto', 'overcast'],
  45: ['Nebbia', 'fog'],
  48: ['Nebbia con brina', 'fog'],
  51: ['Pioviggine debole', 'drizzle'],
  53: ['Pioviggine', 'drizzle'],
  55: ['Pioviggine intensa', 'drizzle'],
  56: ['Pioviggine gelata', 'sleet'],
  57: ['Pioviggine gelata intensa', 'sleet'],
  61: ['Pioggia debole', 'rain-light'],
  63: ['Pioggia', 'rain'],
  65: ['Pioggia forte', 'rain-heavy'],
  66: ['Pioggia gelata', 'sleet'],
  67: ['Pioggia gelata forte', 'sleet'],
  71: ['Neve debole', 'snow'],
  73: ['Neve', 'snow'],
  75: ['Neve forte', 'snow'],
  77: ['Granuli di neve', 'snow'],
  80: ['Rovesci deboli', 'showers'],
  81: ['Rovesci', 'showers'],
  82: ['Rovesci violenti', 'rain-heavy'],
  85: ['Rovesci di neve', 'snow'],
  86: ['Forti rovesci di neve', 'snow'],
  95: ['Temporale', 'thunder'],
  96: ['Temporale con grandine', 'thunder'],
  99: ['Temporale con forte grandine', 'thunder'],
};

export function describe(code) {
  return CODES[code]?.[0] ?? '—';
}

// --- Icone -------------------------------------------------------------------

const SUN = (cx = 16, cy = 16, r = 5.5) => {
  let rays = '';
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    const x1 = cx + Math.cos(rad) * (r + 2.6), y1 = cy + Math.sin(rad) * (r + 2.6);
    const x2 = cx + Math.cos(rad) * (r + 5), y2 = cy + Math.sin(rad) * (r + 5);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  return `<g class="wi-sun"><circle cx="${cx}" cy="${cy}" r="${r}"/><g class="wi-rays">${rays}</g></g>`;
};
const MOON = (dx = 0, dy = 0, s = 1) =>
  `<path class="wi-moon" transform="translate(${dx} ${dy}) scale(${s})" d="M20.5 21.5A8.5 8.5 0 0 1 12.6 7.3a8.5 8.5 0 1 0 11.6 11.6 8.4 8.4 0 0 1-3.7 2.6z"/>`;
const CLOUD = (dy = 0, cls = 'wi-cloud') =>
  `<path class="${cls}" transform="translate(0 ${dy})" d="M9.5 25h13.3a5.2 5.2 0 0 0 .5-10.4 7.2 7.2 0 0 0-13.8 1.7A4.4 4.4 0 0 0 9.5 25z"/>`;
const DROPS = (n, heavy = false) => {
  const xs = n === 2 ? [12.5, 19.5] : [10.5, 16, 21.5];
  return xs.map((x) => `<line class="wi-drop${heavy ? ' heavy' : ''}" x1="${x}" y1="24" x2="${x - 1.6}" y2="${heavy ? 30 : 28.5}"/>`).join('');
};
const FLAKES = () => [10.5, 16, 21.5].map((x, i) => `<circle class="wi-flake" cx="${x}" cy="${i % 2 ? 29 : 26.5}" r="1.4"/>`).join('');
const BOLT = `<path class="wi-bolt" d="M17 20.5h-3.6l-1.9 5.8h3l-1.3 5.2 5.6-7.3h-3.2z"/>`;

function iconBody(kind, day) {
  const celestial = day ? SUN(11.5, 11.5, 4.6) : MOON(-4, -4, 0.95);
  switch (kind) {
    case 'clear': return day ? SUN() : MOON(0, 0, 1.05);
    case 'mostly-clear': return (day ? SUN(13.5, 13.5, 5.2) : MOON(-2, -2, 1)) + `<path class="wi-cloud" transform="translate(6 7) scale(.62)" d="M9.5 25h13.3a5.2 5.2 0 0 0 .5-10.4 7.2 7.2 0 0 0-13.8 1.7A4.4 4.4 0 0 0 9.5 25z"/>`;
    case 'partly': return celestial + CLOUD(1);
    case 'overcast': return `<path class="wi-cloud back" transform="translate(4 -5) scale(.8)" d="M9.5 25h13.3a5.2 5.2 0 0 0 .5-10.4 7.2 7.2 0 0 0-13.8 1.7A4.4 4.4 0 0 0 9.5 25z"/>` + CLOUD(1);
    case 'fog': return CLOUD(-4) + '<g class="wi-fog"><line x1="7" y1="25" x2="25" y2="25"/><line x1="9" y1="29" x2="23" y2="29"/></g>';
    case 'drizzle': return CLOUD(-4) + DROPS(2);
    case 'rain-light': return CLOUD(-4) + DROPS(2);
    case 'rain': return CLOUD(-4) + DROPS(3);
    case 'rain-heavy': return CLOUD(-4, 'wi-cloud dark') + DROPS(3, true);
    case 'showers': return (day ? SUN(10.5, 9, 4) : MOON(-5, -6, 0.85)) + CLOUD(-4) + DROPS(2);
    case 'sleet': return CLOUD(-4) + `<line class="wi-drop" x1="12.5" y1="24" x2="10.9" y2="28.5"/><circle class="wi-flake" cx="19.5" cy="27" r="1.4"/>`;
    case 'snow': return CLOUD(-4) + FLAKES();
    case 'thunder': return CLOUD(-6, 'wi-cloud dark') + BOLT;
    default: return '';
  }
}

export function icon(code, isDay = 1, size = 32, title = '') {
  if (code == null) return `<span class="wi wi-none" style="width:${size}px;height:${size}px"></span>`;
  const kind = CODES[code]?.[1] ?? 'overcast';
  const t = title || describe(code);
  return `<svg class="wi" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="${t}"><title>${t}</title>${iconBody(kind, !!isDay)}</svg>`;
}

// Icona alba/tramonto: mezzo sole sull'orizzonte, raggi e freccia su/giù.
export function sunEventIcon(kind, size = 18) {
  const rise = kind === 'rise';
  const arrow = rise ? 'M12 1.8v4.4M9.8 4l2.2-2.2L14.2 4' : 'M12 1.8v4.4M9.8 4l2.2 2.2L14.2 4';
  return `<svg class="sun-ev ${kind}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path class="rays" d="M4.2 11.6l1.6 1M19.8 11.6l-1.6 1M7.2 8.2l1 1.5M16.8 8.2l-1 1.5"/>
    <path class="disc" d="M6.5 17.5a5.5 5.5 0 0 1 11 0z"/>
    <path class="hz" d="M2.5 17.5h19M6 20.5h12"/>
    <path class="arr" d="${arrow}"/>
  </svg>`;
}

// --- Formattazione -------------------------------------------------------------

const nf = (d) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF0 = nf(0), NF1 = nf(1);

export function fmt(v, decimals = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return (decimals ? NF1 : NF0).format(v);
}

export function fmtSigned(v, decimals = 1) {
  if (v == null) return '—';
  const s = fmt(Math.abs(v), decimals);
  if (Number(s.replace(',', '.')) === 0) return '0';
  return (v > 0 ? '+' : '−') + s;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const windDir = (deg) => (deg == null ? '' : DIRS[Math.round(deg / 45) % 8]);

// Freccia che punta verso dove soffia il vento (direzione di provenienza + 180°).
export function windArrow(deg, size = 14) {
  if (deg == null) return '';
  return `<svg class="wind-arrow" viewBox="0 0 16 16" width="${size}" height="${size}" style="transform:rotate(${deg + 180}deg)" aria-hidden="true"><path d="M8 1.5 12.5 13 8 10.5 3.5 13z"/></svg>`;
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const WEEKDAYS_LONG = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// Le date restituite da Open-Meteo sono "locali" alla località (es. 2026-10-06T14:00):
// vengono lette come componenti senza conversioni di fuso.
export function parts(iso) {
  const [d, t = '00:00'] = iso.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return { y, m, day, hh, mm, wd };
}

export const hourLabel = (iso) => iso.slice(11, 16);
export const dayShort = (iso) => { const p = parts(iso); return `${WEEKDAYS[p.wd]} ${p.day}`; };
export const dayLong = (iso) => { const p = parts(iso); return `${WEEKDAYS_LONG[p.wd]} ${p.day} ${MONTHS[p.m - 1]}`; };

// Titolo di una giornata: "Oggi" / "Domani" / "Dopodomani" (altrimenti il giorno della
// settimana) e la data con il giorno abbreviato alle prime 3 lettere,
// es. { title: 'Domani', date: 'gio 08/10' }.
export function dayTitle(iso, todayIso) {
  const p = parts(iso);
  const diff = Math.round((Date.UTC(p.y, p.m - 1, p.day) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
  const title = ['Oggi', 'Domani', 'Dopodomani'][diff] ?? WEEKDAYS_LONG[p.wd];
  const dd = String(p.day).padStart(2, '0'), mm = String(p.m).padStart(2, '0');
  return { title, date: `${WEEKDAYS_LONG[p.wd].slice(0, 3).toLowerCase()} ${dd}/${mm}` };
}

export function dayRelative(iso, todayIso) {
  const d = iso.slice(0, 10);
  if (d === todayIso) return 'Oggi';
  const t = new Date(`${todayIso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  if (d === t.toISOString().slice(0, 10)) return 'Domani';
  return dayLong(iso);
}

// Ora corrente nel fuso della località, nello stesso formato delle API ("YYYY-MM-DDTHH:00").
export function localNowIso(utcOffsetSeconds) {
  return new Date(Date.now() + utcOffsetSeconds * 1000).toISOString().slice(0, 13) + ':00';
}

// Data/ora di un istante (ms) nel fuso della località, es. { day: "06 ott", time: "14:05" }.
// Usa il fuso IANA restituito dall'API (gestisce l'ora legale); se non riconosciuto,
// ripiega sullo scostamento UTC corrente della località.
export function localDateTime(ms, timeZone, utcOffsetSeconds = 0) {
  let y, m, d, hh, mm;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    [y, m, d, hh, mm] = [p.year, p.month, p.day, p.hour, p.minute];
  } catch {
    const iso = new Date(ms + utcOffsetSeconds * 1000).toISOString();
    [y, m, d, hh, mm] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), iso.slice(11, 13), iso.slice(14, 16)];
  }
  return { date: `${y}-${m}-${d}`, day: `${d} ${MONTHS[Number(m) - 1]}`, time: `${hh}:${mm}` };
}

export function fmtAgo(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h fa`;
  return `${Math.floor(h / 24)} g fa`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
