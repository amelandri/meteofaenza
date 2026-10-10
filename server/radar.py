"""Radar della Protezione Civile: pioggia vista adesso intorno a Faenza, movimento e stima
dei prossimi 90 minuti (nowcasting), immagini per l'animazione.

Prodotto SRI (Surface Rainfall Intensity): mosaico nazionale in mm/h, 1200 × 1400 pixel da
1 km, un'immagine ogni 5 minuti (pubblicata ~7–8 minuti dopo). GeoTIFF a 32 bit con
compressione LZW, letto con Pillow; -9999 = fuori copertura. Proiezione fissa (dal file):
trasversa di Mercatore WGS84 con origine 42°N 12,5°E, angolo in alto a sinistra a
(-600 km, +650 km): la posizione di Faenza si calcola con tm_forward(), senza GDAL.

Unica parte del server che usa librerie esterne (numpy e Pillow, da apt: vedi CLAUDE.md):
si importano qui e solo il job del radar le richiede. Gli altri moduli importano da qui solo
costanti e funzioni che non le usano.

Metodo:
- movimento: correlazione incrociata (FFT) tra l'immagine di 15 minuti prima (o 10) e
  l'ultima, sul campo di pioggia in scala logaritmica e ammorbidito, in un riquadro di
  ±MOTION_HALF km. La correlazione "di fase" (normalizzata) è stata provata e scartata: dà
  troppo peso ai dettagli e ai bordi fissi della copertura e restituiva spesso zero.
- stima: per ogni minuto L la pioggia che arriverà su Faenza è quella che adesso si trova a
  -velocità × L; si guarda un cerchio che si allarga con L (l'incertezza cresce) e se ne
  prende la quota con pioggia (frac) e l'intensità media dove piove (mmh).
"""

import io
import json
import math
import zlib

from . import config, db, sources

RAIN_MMH = 0.3  # mm/h oltre cui il radar "vede pioggia" (sotto è soprattutto rumore)
MOTION_HALF = 100  # km: riquadro (2×100+1 px) per movimento e proiezione
VIEW_HALF = 60  # km: riquadro dell'immagine mostrata (il cerchio dei 50 km con un po' di margine)
NEAR_KM = 50  # raggio entro cui si cerca la pioggia più vicina
LEADS = list(range(0, 95, 5))  # minuti della stima
IMAGE_LEADS = (15, 30, 45, 60)  # minuti delle immagini di proiezione
ARRIVE_FRAC = 0.5  # quota della zona con pioggia per dire "in arrivo"
MAYBE_FRAC = 0.25  # …e per dire "possibile"
MAX_SPEED_KMH = 120  # oltre è un errore del calcolo
GRID = {'lat0': 42.0, 'lon0': 12.5, 'x0': -600000.0, 'y0': 650000.0, 'px': 1000.0}

# Riferimenti dell'immagine: città vicine e costa (Natural Earth 1:10m, dominio pubblico,
# ritagliata e semplificata), in lat/lon; convertiti in pixel in view_geometry(). Per le città
# un quarto valore True mette il nome a sinistra del punto (vicino al bordo destro).
CITIES = [
    ('Faenza', config.LAT, config.LON), ('Bologna', 44.4949, 11.3426), ('Imola', 44.3534, 11.7146),
    ('Lugo', 44.4214, 11.9116), ('Forlì', 44.2227, 12.0407), ('Ravenna', 44.4184, 12.2035),
    ('Cesena', 44.1396, 12.2431), ('Rimini', 44.0678, 12.5695, True), ('Brisighella', 44.2213, 11.7730, True),
    ('Marradi', 44.0774, 11.6139),
]
COAST = [[[45.3, 12.354], [45.27, 12.337], [45.256, 12.304], [45.223, 12.278], [45.205, 12.302], [45.201, 12.379], [45.167, 12.326], [45.127, 12.317], [45.119, 12.371], [45.072, 12.361], [45.032, 12.383], [45.003, 12.4], [45.007, 12.458], [44.98, 12.531], [44.947, 12.538], [44.906, 12.481], [44.877, 12.412], [44.823, 12.381], [44.828, 12.304], [44.795, 12.285], [44.731, 12.249], [44.649, 12.268], [44.551, 12.296], [44.476, 12.296], [44.384, 12.326], [44.282, 12.363], [44.218, 12.39], [44.149, 12.453], [44.092, 12.522], [44.039, 12.606], [43.983, 12.678], [43.955, 12.72], [43.925, 12.763], [43.876, 12.889], [43.842, 12.988], [43.799, 13.055], [43.757, 13.133], [43.702, 13.236], [43.65, 13.311], [43.62, 13.379], [43.613, 13.4]]]

# Confini regionali (Emilia-Romagna con Toscana e Marche) e di San Marino nel riquadro, dai
# confini ISTAT 2026 (geojson-italy di openpolis, CC BY), semplificati: un elenco di tratti.
# Tolta l'exclave toscana di Ca' Raffaello (Badia Tedalda), minuscola e fonte di confusione.
BORDERS = [[[43.969, 12.751], [43.96, 12.754], [43.922, 12.729], [43.912, 12.727], [43.896, 12.735], [43.88, 12.723], [43.87, 12.734], [43.861, 12.722], [43.853, 12.682], [43.839, 12.678], [43.828, 12.681], [43.825, 12.675], [43.827, 12.644], [43.821, 12.624], [43.834, 12.61], [43.843, 12.619], [43.846, 12.616], [43.846, 12.605], [43.851, 12.601], [43.862, 12.603], [43.865, 12.589], [43.886, 12.589], [43.885, 12.572], [43.869, 12.56], [43.865, 12.541], [43.875, 12.519], [43.881, 12.518], [43.875, 12.502], [43.88, 12.494], [43.886, 12.487], [43.896, 12.487]],
           [[43.894, 12.462], [43.878, 12.456], [43.871, 12.446], [43.875, 12.432], [43.872, 12.43], [43.873, 12.401], [43.87, 12.404], [43.867, 12.397], [43.847, 12.391], [43.826, 12.399], [43.817, 12.388], [43.813, 12.368], [43.8, 12.35], [43.806, 12.316], [43.795, 12.286], [43.789, 12.283], [43.786, 12.289], [43.765, 12.284], [43.76, 12.258], [43.753, 12.254], [43.751, 12.242], [43.76, 12.229], [43.755, 12.209], [43.745, 12.198], [43.732, 12.195], [43.762, 12.16], [43.752, 12.14], [43.749, 12.124], [43.754, 12.107], [43.741, 12.07], [43.757, 12.053], [43.755, 12.044], [43.765, 12.01], [43.762, 11.987], [43.776, 11.953], [43.79, 11.948], [43.799, 11.913], [43.808, 11.914], [43.813, 11.91], [43.809, 11.887], [43.817, 11.867], [43.816, 11.856], [43.808, 11.842], [43.816, 11.821], [43.848, 11.784], [43.863, 11.732], [43.874, 11.722], [43.877, 11.71], [43.888, 11.709], [43.922, 11.717], [43.935, 11.684], [43.956, 11.691], [43.975, 11.654], [43.991, 11.646], [44.003, 11.65], [44.006, 11.664], [44.018, 11.658], [44.021, 11.682], [44.039, 11.696], [44.056, 11.701], [44.085, 11.733], [44.121, 11.753], [44.126, 11.745], [44.121, 11.72], [44.123, 11.682], [44.101, 11.653], [44.112, 11.639], [44.119, 11.614], [44.112, 11.585], [44.124, 11.588], [44.125, 11.6], [44.137, 11.604], [44.143, 11.617], [44.158, 11.615], [44.161, 11.578], [44.167, 11.564], [44.165, 11.552], [44.159, 11.553], [44.153, 11.545], [44.158, 11.516], [44.176, 11.486], [44.18, 11.49], [44.184, 11.484], [44.186, 11.468], [44.194, 11.455], [44.2, 11.448], [44.212, 11.455], [44.221, 11.451], [44.239, 11.421], [44.217, 11.394], [44.2, 11.381], [44.204, 11.341], [44.196, 11.327], [44.182, 11.323], [44.173, 11.31], [44.172, 11.296], [44.168, 11.298], [44.156, 11.281], [44.159, 11.239], [44.15, 11.214], [44.151, 11.196], [44.143, 11.196], [44.132, 11.215], [44.116, 11.26], [44.104, 11.264], [44.098, 11.247], [44.102, 11.229], [44.099, 11.208], [44.112, 11.155], [44.11, 11.128], [44.09, 11.089], [44.09, 11.049], [44.095, 11.047], [44.097, 11.024], [44.112, 11.002], [44.122, 11.006], [44.125, 11.015], [44.137, 11.014], [44.139, 11.006], [44.136, 10.996], [44.13, 10.994], [44.116, 10.971], [44.102, 10.964]],
           [[43.903, 12.49], [43.918, 12.492], [43.942, 12.516], [43.959, 12.507], [43.98, 12.51], [43.985, 12.516], [43.991, 12.514], [43.991, 12.507], [43.975, 12.464], [43.959, 12.439], [43.952, 12.414], [43.956, 12.405], [43.944, 12.405], [43.931, 12.415], [43.922, 12.408], [43.909, 12.413], [43.903, 12.408], [43.899, 12.418], [43.906, 12.44], [43.894, 12.457]],
           [[43.894, 12.463], [43.897, 12.481]]]


# --- Geometria -----------------------------------------------------------------------

def tm_forward(lat, lon, lat0=GRID['lat0'], lon0=GRID['lon0']):
    """Trasversa di Mercatore su WGS84 (Snyder, Map Projections, 1987): metri (est, nord)."""
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    phi, phi0 = math.radians(lat), math.radians(lat0)

    def meridian(p):
        return a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
                    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * p)
                    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * p)
                    - (35 * e2 ** 3 / 3072) * math.sin(6 * p))
    n = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    t = math.tan(phi) ** 2
    c = ep2 * math.cos(phi) ** 2
    A = math.radians(lon - lon0) * math.cos(phi)
    x = n * (A + (1 - t + c) * A ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * A ** 5 / 120)
    y = meridian(phi) - meridian(phi0) + n * math.tan(phi) * (
        A ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * A ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * A ** 6 / 720)
    return x, y


def to_pixel(lat, lon):
    """(colonna, riga) nel mosaico, con decimali (il centro del pixel è a +0,5)."""
    x, y = tm_forward(lat, lon)
    return (x - GRID['x0']) / GRID['px'], (GRID['y0'] - y) / GRID['px']


def center_pixel():
    col, row = to_pixel(config.LAT, config.LON)
    return int(row), int(col)


COMPASS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest']


def compass(dx, dy):
    """Direzione (8 punti) di uno spostamento in pixel (dx verso est, dy verso sud)."""
    deg = (math.degrees(math.atan2(dx, -dy)) + 360) % 360
    return round(deg), COMPASS[int((deg + 22.5) // 45) % 8]


def view_geometry():
    """Città e costa in pixel dell'immagine mostrata (0…2×VIEW_HALF+1), per il disegno nel browser."""
    row0, col0 = center_pixel()

    def px(lat, lon):
        col, row = to_pixel(lat, lon)
        return round(col - (col0 - VIEW_HALF), 1), round(row - (row0 - VIEW_HALF), 1)
    return {
        'size': 2 * VIEW_HALF + 1, 'km': VIEW_HALF,
        'cities': [{'name': c[0], 'x': px(c[1], c[2])[0], 'y': px(c[1], c[2])[1], 'left': len(c) > 3 and c[3]} for c in CITIES],
        'coast': [[px(la, lo) for la, lo in line] for line in COAST],
        'borders': [[px(la, lo) for la, lo in line] for line in BORDERS],
    }


# --- Griglie (numpy) -----------------------------------------------------------------

def _np():
    import numpy as np  # noqa: PLC0415 (solo per il job del radar)
    return np


def decode(tif):
    """Ritaglio di ±MOTION_HALF km intorno a Faenza dal GeoTIFF (float32, NaN fuori copertura)."""
    np = _np()
    from PIL import Image  # noqa: PLC0415
    try:
        g = np.array(Image.open(io.BytesIO(tif)), dtype=np.float32)
    except Exception as err:  # formato cambiato o file rovinato
        raise sources.SourceError(f'radar: immagine non leggibile ({err})') from err
    if g.shape != (1400, 1200):
        raise sources.SourceError(f'radar: dimensioni inattese {g.shape}')
    row, col = center_pixel()
    h = MOTION_HALF
    crop = g[row - h:row + h + 1, col - h:col + h + 1].copy()
    crop[crop < 0] = np.nan
    return crop


def pack(grid):
    np = _np()
    return zlib.compress(grid.astype(np.float16).tobytes(), 6)


def unpack(blob):
    np = _np()
    n = 2 * MOTION_HALF + 1
    return np.frombuffer(zlib.decompress(blob), dtype=np.float16).astype(np.float32).reshape(n, n)


def window(grid, cy, cx, half):
    """Riquadro di lato 2×half+1 centrato in (cy, cx), con NaN dove esce dalla griglia."""
    np = _np()
    n = 2 * half + 1
    out = np.full((n, n), np.nan, dtype=np.float32)
    y0, x0 = cy - half, cx - half
    sy0, sx0 = max(0, y0), max(0, x0)
    sy1, sx1 = min(grid.shape[0], y0 + n), min(grid.shape[1], x0 + n)
    if sy1 > sy0 and sx1 > sx0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = grid[sy0:sy1, sx0:sx1]
    return out


def _blur(f, k=2):
    """Media mobile (2k+1)×(2k+1) con somme cumulate."""
    np = _np()
    n = 2 * k + 1
    c = np.pad(np.pad(f, k, mode='edge').cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n * n)


def _field(g):
    np = _np()
    v = np.nan_to_num(g, nan=0.0)
    return _blur(np.log1p(np.where(v >= RAIN_MMH, v, 0.0)))


def motion(older, newer, minutes):
    """Velocità della pioggia (pixel/minuto: verso est, verso sud) tra due ritagli, o None
    se c'è troppa poca pioggia per dirlo o il risultato non è plausibile."""
    np = _np()
    if min(int(np.sum(np.nan_to_num(g) >= RAIN_MMH)) for g in (older, newer)) < 40:
        return None
    a, b = _field(older), _field(newer)
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    a, b = (a - a.mean()) * win, (b - b.mean()) * win
    r = np.fft.fftshift(np.fft.ifft2(np.fft.fft2(b) * np.conj(np.fft.fft2(a))).real)
    m = int(MAX_SPEED_KMH / 60 * minutes) + 1
    cy, cx = r.shape[0] // 2, r.shape[1] // 2
    sub = r[cy - m:cy + m + 1, cx - m:cx + m + 1]
    iy, ix = np.unravel_index(int(np.argmax(sub)), sub.shape)

    def parabola(lo, mid, hi):  # posizione del massimo tra i pixel vicini
        d = lo - 2 * mid + hi
        return 0.0 if d == 0 else 0.5 * (lo - hi) / d
    fy = parabola(sub[iy - 1, ix], sub[iy, ix], sub[iy + 1, ix]) if 0 < iy < 2 * m else 0.0
    fx = parabola(sub[iy, ix - 1], sub[iy, ix], sub[iy, ix + 1]) if 0 < ix < 2 * m else 0.0
    dy, dx = (iy - m + fy) / minutes, (ix - m + fx) / minutes
    if math.hypot(dx, dy) * 60 > MAX_SPEED_KMH:
        return None
    return float(dx), float(dy)


def _disc(grid, cy, cx, radius):
    """Valori validi nel cerchio di raggio `radius` px intorno a (cy, cx)."""
    np = _np()
    r = int(math.ceil(radius))
    w = window(grid, int(round(cy)), int(round(cx)), r)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    vals = w[(yy ** 2 + xx ** 2 <= radius ** 2)]
    return vals[~np.isnan(vals)]


def radius_km(lead):
    """Raggio della zona guardata per la stima a `lead` minuti (l'incertezza cresce)."""
    return 3 + lead / 10


def nowcast(grid, v):
    """Stima per i minuti LEADS: quota della zona con pioggia e intensità media dove piove."""
    np = _np()
    c = MOTION_HALF
    out = []
    for lead in LEADS:
        if lead and v is None:
            break
        dx, dy = v if v else (0.0, 0.0)
        vals = _disc(grid, c - dy * lead, c - dx * lead, radius_km(lead))
        if vals.size < 10:  # la pioggia di quel momento verrebbe da fuori del riquadro
            break
        wet = vals[vals >= RAIN_MMH]
        out.append({'min': lead, 'frac': round(float(wet.size / vals.size), 2),
                    'mmh': round(float(wet.mean()), 1) if wet.size else 0.0})
    return out


def nearest(grid):
    """Pioggia più vicina entro NEAR_KM: distanza, direzione, intensità; None se non c'è."""
    np = _np()
    c = MOTION_HALF
    yy, xx = np.mgrid[-c:c + 1, -c:c + 1]
    d = np.hypot(yy, xx)
    wet = (np.nan_to_num(grid) >= RAIN_MMH) & (d <= NEAR_KM)
    if not wet.any():
        return None
    k = np.argmin(np.where(wet, d, np.inf))
    iy, ix = np.unravel_index(int(k), d.shape)
    deg, name = compass(ix - c, iy - c)
    return {'km': int(round(d[iy, ix])), 'deg': deg, 'dir': name, 'mmh': round(float(grid[iy, ix]), 1)}


# --- Immagini --------------------------------------------------------------------------

# Scala dei colori (mm/h) dell'immagine: sotto RAIN_MMH trasparente, fuori copertura grigio.
PALETTE = [
    (RAIN_MMH, (166, 216, 255)), (1, (95, 177, 245)), (2.5, (43, 125, 224)), (5, (29, 79, 184)),
    (10, (242, 194, 48)), (20, (240, 138, 36)), (40, (217, 58, 43)),
]


def legend():
    return [{'from': lo, 'color': '#%02x%02x%02x' % rgb} for lo, rgb in PALETTE]


def render_png(view):
    """PNG con tavolozza (pochi KB): 0 = asciutto (trasparente), 1 = fuori copertura."""
    np = _np()
    from PIL import Image  # noqa: PLC0415
    idx = np.zeros(view.shape, dtype=np.uint8)
    idx[np.isnan(view)] = 1
    v = np.nan_to_num(view)
    for k, (lo, _) in enumerate(PALETTE):
        idx[v >= lo] = k + 2
    pal = [0, 0, 0, 128, 128, 128] + [c for _, rgb in PALETTE for c in rgb]
    im = Image.frombytes('P', (idx.shape[1], idx.shape[0]), idx.tobytes())
    im.putpalette(pal + [0] * (768 - len(pal)))
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True, transparency=bytes([0, 70] + [255] * len(PALETTE)))
    return buf.getvalue()


# --- Job ---------------------------------------------------------------------------------

def _store_frame(conn, t, grid):
    c = MOTION_HALF
    conn.execute('INSERT OR REPLACE INTO radar_frames (time, fetched_at, grid) VALUES (?, ?, ?)', (t, db.now_ms(), pack(grid)))
    _store_image(conn, t, grid)
    here = _disc(grid, c, c, 2)
    conn.execute('INSERT OR REPLACE INTO radar_obs (time, mmh) VALUES (?, ?)',
                 (t, round(float(here.mean()), 2) if here.size else None))


def _obs_name(t):
    """Nome dell'immagine misurata: comprende il riquadro, così cambiando VIEW_HALF le immagini
    già salvate (di un'altra dimensione) non si mescolano con la nuova geometria."""
    return f'o{t}_{VIEW_HALF}'


def _store_image(conn, t, grid):
    c = MOTION_HALF
    conn.execute('INSERT OR REPLACE INTO radar_images (name, created_at, png) VALUES (?, ?, ?)',
                 (_obs_name(t), t, render_png(window(grid, c, c, VIEW_HALF))))


def _grid_at(conn, t):
    row = conn.execute('SELECT grid FROM radar_frames WHERE time = ?', (t,)).fetchone()
    return unpack(row['grid']) if row else None


def run(conn, force=False):
    """Job del radar: scarica le immagini nuove (al massimo le ultime 4, per recuperare un
    buco), calcola movimento e stima, prepara le immagini e il riepilogo (snapshot 'radar')."""
    last = sources.fetch_radar_last()
    have = {r['time'] for r in conn.execute('SELECT time FROM radar_frames WHERE time >= ?', (last - 20 * 60000,))}
    new = [t for t in (last - 15 * 60000, last - 10 * 60000, last - 5 * 60000, last) if t not in have]
    if not new and not force:
        return 'nessuna immagine nuova'
    got = 0
    for t in new:
        try:
            _store_frame(conn, t, decode(sources.fetch_radar_tif(t)))
            got += 1
        except sources.SourceError:
            if t == last:
                raise
    conn.commit()
    latest = _grid_at(conn, last)
    if latest is None:
        raise sources.SourceError('radar: ultima immagine non salvata')
    v = None
    for minutes in (15, 10):  # base più lunga = movimento più preciso
        older = _grid_at(conn, last - minutes * 60000)
        if older is not None:
            v = motion(older, latest, minutes)
            break
    steps = nowcast(latest, v)
    conn.executemany('INSERT OR REPLACE INTO radar_nowcast (issued, lead, frac, mmh) VALUES (?, ?, ?, ?)',
                     [(last, s['min'], s['frac'], s['mmh']) for s in steps])
    # Immagini della proiezione: l'ultima immagine spostata lungo il movimento.
    c = MOTION_HALF
    forecast = []
    if v:
        for lead in IMAGE_LEADS:
            dx, dy = v
            view = window(latest, int(round(c - dy * lead)), int(round(c - dx * lead)), VIEW_HALF)
            name = f'f{last}_{lead}_{VIEW_HALF}'
            conn.execute('INSERT OR REPLACE INTO radar_images (name, created_at, png) VALUES (?, ?, ?)',
                         (name, last, render_png(view)))
            forecast.append({'t': last + lead * 60000, 'min': lead, 'img': f'api/radar/{name}.png'})
    # Immagini dell'ultima ora: quelle mancanti (es. dopo un cambio di VIEW_HALF) si ridisegnano
    # dai ritagli salvati.
    frames = []
    for r in conn.execute('SELECT time FROM radar_frames WHERE time >= ? ORDER BY time', (last - 60 * 60000,)).fetchall():
        t = r['time']
        if not conn.execute('SELECT 1 FROM radar_images WHERE name = ?', (_obs_name(t),)).fetchone():
            _store_image(conn, t, _grid_at(conn, t))
        frames.append({'t': t, 'img': f'api/radar/{_obs_name(t)}.png'})
    summary = {
        'time': last,
        'now': steps[0]['mmh'] if steps and steps[0]['frac'] >= ARRIVE_FRAC else 0.0,
        'nearest': nearest(latest),
        'motion': None,
        'nowcast': steps,
        'rainMmh': RAIN_MMH, 'arriveFrac': ARRIVE_FRAC, 'maybeFrac': MAYBE_FRAC,
    }
    if v:
        deg, name = compass(*v)
        summary['motion'] = {'kmh': round(math.hypot(*v) * 60), 'deg': deg, 'dir': name}
    db.put_snapshot(conn, 'radar', {**summary, 'frames': frames, 'forecast': forecast})
    conn.commit()
    speed = f", movimento {summary['motion']['kmh']} km/h verso {summary['motion']['dir']}" if v else ''
    return f"{got} immagini nuove (ultima {last}){speed}"


# --- API (senza numpy) --------------------------------------------------------------------

def compose(conn, full=True):
    """Riepilogo del radar (per api/station) o, con `full`, anche immagini e geometria (api/radar).
    None se manca o è più vecchio di RADAR_MAX_AGE_S."""
    snap = db.get_snapshot(conn, 'radar')
    if not snap or db.now_ms() - snap['data']['time'] > config.RADAR_MAX_AGE_S * 1000:
        return None
    data = dict(snap['data'], fetchedAt=snap['fetched_at'])
    if not full:
        data.pop('frames', None)
        data.pop('forecast', None)
        return data
    return {**data, 'view': view_geometry(), 'legend': legend()}


def image(conn, name):
    row = conn.execute('SELECT png FROM radar_images WHERE name = ?', (name,)).fetchone()
    return row['png'] if row else None


if __name__ == '__main__':  # prova: python3 -m server.radar
    print(json.dumps(view_geometry())[:300])
