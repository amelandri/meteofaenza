"""Test del server (senza rete): python3 -m unittest discover -s tests"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Database temporaneo, prima di importare la configurazione.
_tmp = tempfile.TemporaryDirectory()
os.environ['METEO_DB'] = str(Path(_tmp.name) / 'test.db')

from server import api, config, db, sources  # noqa: E402

STATION_JS = """
var currentTimeMillis = '1791551161652';
var temperature = '22.5';
var temperatureMin = '15.4';
var temperatureMinTime = '8:11';
var temperatureMax = '23.9';
var temperatureMaxTime = '12:47';
var humidity = '70';
var windSpeed = '';
var rainfall = '9.4';
var rainfallYear = '427.8';
var pressureMax = '1013.6';
var pressureMaxTime = '10:42';
var sunrise = '07:18';
var skytransparency = '9';
"""


class StationTest(unittest.TestCase):
    def test_parse(self):
        r = sources.parse_station(STATION_JS, fetched_at=1)
        self.assertEqual(r['time'], 1791551161652)
        self.assertEqual(r['temperature'], 22.5)
        self.assertEqual(r['tMinTime'], '08:11')  # ora con lo zero davanti
        self.assertIsNone(r['windSpeed'])  # stringa vuota → None
        self.assertEqual(r['rainToday'], 9.4)
        self.assertEqual(r['rainYear'], 427.8)
        self.assertEqual((r['pressureMax'], r['pressureMaxTime']), (1013.6, '10:42'))
        self.assertEqual(r['sunrise'], '07:18')
        self.assertEqual(r['skyTransparency'], 9)
        self.assertIsNone(r['radiationMax'])  # campo assente → None

    def test_parse_invalid(self):
        with self.assertRaises(sources.SourceError):
            sources.parse_station("var temperature = '';")

    def test_rain_log(self):
        conn = db.connect()
        base = 1791551161652
        for k, mm in enumerate([1.0, 1.0, 1.4]):
            r = sources.parse_station(STATION_JS, fetched_at=1)
            r.update(time=base + k * 600_000, rainToday=mm)
            db.put_station(conn, r)
        st = api.compose_station(conn)
        self.assertEqual(st['time'], base + 1_200_000)
        self.assertEqual([e['mm'] for e in st['rainLog']], [1.0, 1.0, 1.4])
        self.assertEqual(st['rainLog'][0]['day'], '2026-10-09')  # data locale (Europe/Rome)
        conn.close()


    def test_station_before_reset(self):
        """Tra mezzanotte e le 01:00 (ora legale) la centralina riporta ancora i valori di ieri:
        api/station li ricalcola da mezzanotte locale."""
        from datetime import datetime, timedelta
        from zoneinfo import ZoneInfo
        old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'reset.db'
        try:
            conn = db.connect()
            start = datetime(2026, 10, 10, tzinfo=ZoneInfo('Europe/Rome'))
            for k, (mm, temp) in enumerate([(11.6, 14.0), (11.6, 13.8), (11.8, 13.5), (12.0, 13.7)]):
                r = sources.parse_station(STATION_JS, fetched_at=1)
                r.update(time=int((start + timedelta(minutes=10 * (k - 1), seconds=20)).timestamp() * 1000),
                         rainToday=mm, temperature=temp, tMin=9.0, tMinTime='05:17', tMax=22.0, tMaxTime='14:00')
                db.put_station(conn, r)
            st = api.compose_station(conn)  # ultima lettura alle 00:20
            self.assertAlmostEqual(st['rainToday'], 0.4)  # non 12,0
            self.assertEqual((st['tMin'], st['tMinTime']), (13.5, '00:10'))
            self.assertEqual((st['tMax'], st['tMaxTime']), (13.8, '00:00'))
            self.assertIsNone(st['windMax'])
            today = [e['mm'] for e in st['rainLog'] if e['day'] == '2026-10-10']
            self.assertEqual(today, [0.0, 0.2, 0.4])  # coerenti con rainToday (pioggia in corso)
            conn.close()
        finally:
            config.DB_PATH = old


class NormalsTest(unittest.TestCase):
    def test_day_of_year(self):
        self.assertEqual(sources.day_of_year('01-01'), 0)
        self.assertEqual(sources.day_of_year('02-29'), 59)
        self.assertEqual(sources.day_of_year('12-31'), 365)

    def test_window_is_circular(self):
        # Un solo valore il 1° gennaio: con ±7 giorni compare anche a fine dicembre.
        out = sources.compute_normals(['2001-01-01'], [10.0])
        self.assertEqual(out[0], 10.0)
        self.assertEqual(out[365], 10.0)  # 31 dicembre: entro 7 giorni
        self.assertIsNone(out[30])


def _forecast(times, days):
    def block(t, names):
        return {'time': t, 'models': {m['key']: {v: list(range(len(t))) for v in names} for m in sources.MODELS}}
    h = block(times, sources.HOURLY_VARS)
    h['precipitation_probability'] = [0] * len(times)
    d = block(days, sources.DAILY_VARS)
    d['sunrise'] = [f'{x}T07:00' for x in days]
    d['sunset'] = [f'{x}T18:00' for x in days]
    return {'utcOffset': 7200, 'hourly': h, 'daily': d}


class TrimTest(unittest.TestCase):
    def test_trim_keeps_yesterday_23(self):
        times = [f'2026-10-08T{h:02d}:00' for h in range(24)] + [f'2026-10-09T{h:02d}:00' for h in range(24)]
        fc = _forecast(times, ['2026-10-08', '2026-10-09'])
        ens = {'time': list(times), 'groups': [{'model': 'X', 'members': [list(range(48))]}]}
        api.trim_forecast(fc, ens, '2026-10-09')
        self.assertEqual(fc['hourly']['time'][0], '2026-10-08T23:00')
        self.assertEqual(fc['hourly']['models']['eu']['temperature_2m'][0], 23)
        self.assertEqual(fc['daily']['time'], ['2026-10-09'])
        self.assertEqual(ens['time'][0], '2026-10-08T23:00')
        self.assertEqual(ens['groups'][0]['members'][0][0], 23)


if __name__ == '__main__':
    unittest.main()


class VerifyTest(unittest.TestCase):
    """Archivio delle previsioni e confronto con le misure (server/verify.py)."""

    DAY = '2026-10-01'

    @classmethod
    def setUpClass(cls):
        from datetime import datetime, timedelta
        from zoneinfo import ZoneInfo
        from server import verify
        cls.verify = verify
        cls.conn = db.connect()
        start = datetime(2026, 10, 1, tzinfo=ZoneInfo('Europe/Rome'))
        # Una lettura ogni 10 minuti; piove 0,5 mm tra le 6 e le 7 e 1,0 mm tra le 14 e le 16.
        mm = 0.0
        for k in range(144):
            t = start + timedelta(minutes=10 * k, seconds=20)
            if 6 * 6 < k <= 7 * 6:
                mm += 0.5 / 6
            if 14 * 6 < k <= 16 * 6:
                mm += 1.0 / 12
            r = sources.parse_station(STATION_JS, fetched_at=1)
            r.update(time=int(t.timestamp() * 1000), rainToday=round(mm, 2), temperature=10 + k / 10,
                     tMin=10.0, tMax=24.3)
            db.put_station(cls.conn, r)

    def test_observed_hourly_rain(self):
        obs = self.verify.observed_day(self.conn, self.DAY)
        # indice h = pioggia nell'ora (h, h+1]
        self.assertAlmostEqual(obs['rain'][6], 0.5, places=1)   # 6–7
        self.assertAlmostEqual(obs['rain'][14] + obs['rain'][15], 1.0, places=1)  # 14–16
        self.assertEqual(obs['rain'][10], 0.0)
        self.assertAlmostEqual(obs['total'], 1.5, places=1)
        self.assertTrue(obs['complete'])
        self.assertIsNone(self.verify.observed_day(self.conn, '2026-09-01'))

    def test_station_resets_after_midnight(self):
        """La centralina azzera i mm "di oggi" alle 01:00 (mezzanotte dell'ora solare): fino ad
        allora riporta il totale e la minima/massima di ieri, che non vanno attribuiti a oggi."""
        from datetime import datetime, timedelta
        from zoneinfo import ZoneInfo
        conn = db.connect()
        start = datetime(2026, 10, 5, tzinfo=ZoneInfo('Europe/Rome'))
        for k in range(-3, 147):
            t = start + timedelta(minutes=10 * k, seconds=20)
            before_reset = k < 6  # fino alle 00:50
            mm = 11.6 if before_reset else (0.4 if k >= 4 * 6 else 0.0)  # 0,4 mm tra le 3 e le 4
            r = sources.parse_station(STATION_JS, fetched_at=1)
            r.update(time=int(t.timestamp() * 1000), rainToday=mm, temperature=14.0 - (0.5 if k == 2 else 0),
                     tMin=9.0 if before_reset else 13.6, tMinTime='05:17',
                     tMax=22.0 if before_reset else 16.0, tMaxTime='14:00' if before_reset else '01:00')
            db.put_station(conn, r)
        obs = self.verify.observed_day(conn, '2026-10-05')
        self.assertEqual(obs['rain'][0], 0.0)  # non gli 11,6 mm di ieri
        self.assertAlmostEqual(obs['rain'][3], 0.4)
        self.assertAlmostEqual(obs['total'], 0.4)
        self.assertEqual((obs['tMin'], obs['tMinTime']), (13.5, '00:20'))  # lettura, non i 9° di ieri
        self.assertEqual((obs['tMax'], obs['tMaxTime']), (16.0, '01:00'))
        conn.close()

    def test_rain_step(self):
        step = lambda a, b: self.verify.rain_step({'rainToday': a}, {'rainToday': b})  # noqa: E731
        self.assertAlmostEqual(step(1.0, 1.4), 0.4)
        self.assertEqual(step(11.6, 0.0), 0.0)  # azzeramento
        self.assertEqual(step(11.6, 0.2), 0.2)  # azzeramento con pioggia subito dopo
        self.assertEqual(step(1.4, 1.3), 0.0)  # piccola correzione

    def test_coarse_blocks(self):
        """Dati ogni 3 ore (ECMWF ENS): la pioggia del blocco è divisa in tre parti uguali; uno
        scenario è bagnato se il totale del blocco arriva a WET_MM."""
        # ore locali con l'ora legale (UTC+2): 00, 01, 02 = UTC 22, 23, 00 → un blocco
        times = [f'2026-10-11T{h:02d}:00' for h in range(6)]
        coarse = [[0.1, 0.1, 0.1, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]
        self.assertEqual(self.verify.coarse_block(coarse, times, 1, 7200), 0)
        self.assertEqual(self.verify.coarse_block(coarse, times, 4, 7200), 3)
        mask, n = self.verify.ensemble_masks(coarse, 1, times, 7200)
        self.assertEqual((mask, n), (0b01, 2))  # 0,3 mm nelle 3 ore
        hourly = [[0.1, 0.0, 0.1, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]
        self.assertIsNone(self.verify.coarse_block(hourly, times, 1, 7200))
        self.assertEqual(self.verify.ensemble_masks(hourly, 0, times, 7200), (0, 2))

    def test_masks(self):
        mask, n = self.verify.ensemble_masks([[0.0], [0.3], [None], [0.2]], 0)
        self.assertEqual((mask, n), (0b1010, 3))

    def test_archive_and_lead(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        times = [f'2026-09-30T{h:02d}:00' for h in range(24)] + [f'2026-10-01T{h:02d}:00' for h in range(24)] + ['2026-10-02T00:00']
        fc = _forecast(times, ['2026-09-30', '2026-10-01'])
        fc['hourly']['models']['eu']['precipitation'] = [0.4] * len(times)
        issued = int(datetime(2026, 9, 30, 9, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)
        runs = {'i2i': {'init': 100}, 'eu': {'init': 200}}
        n1 = self.verify.archive_forecast(self.conn, fc, runs, issued)
        n2 = self.verify.archive_forecast(self.conn, fc, runs, issued + 60_000)  # stesso run: niente
        self.assertGreater(n1, 0)
        self.assertEqual(n2, 0)
        f = self.verify.forecast_day(self.conn, self.DAY, 1)
        self.assertEqual(f['eu']['runInit'], 200)
        self.assertEqual(f['eu']['rain'][6], 0.4)
        # Due giorni prima: il limite è la mezzanotte del 30, la previsione del 30 alle 9 non vale.
        self.assertIsNone(self.verify.forecast_day(self.conn, self.DAY, 2)['eu'])

    def test_compose(self):
        res = self.verify.compose_verify(self.conn, 120, 1)
        self.assertEqual(res['lead'], 1)
        self.assertIn(self.DAY, [d['day'] for d in res['days']])


try:
    import numpy as np  # noqa: F401  (numpy e Pillow servono solo al radar)
    import PIL  # noqa: F401
    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False


class RadarGeometryTest(unittest.TestCase):
    """Geometria del mosaico (senza numpy)."""

    def test_faenza_pixel(self):
        from server import radar
        col, row = radar.to_pixel(44.29007, 11.87948)
        self.assertEqual((int(row), int(col)), (395, 550))  # verificato sull'immagine reale

    def test_compass(self):
        from server import radar
        self.assertEqual(radar.compass(1, 0)[1], 'est')
        self.assertEqual(radar.compass(0, -1)[1], 'nord')  # dy verso sud: -1 = nord
        self.assertEqual(radar.compass(-1, 1)[1], 'sud-ovest')

    def test_view_geometry(self):
        from server import radar
        v = radar.view_geometry()
        faenza = v['cities'][0]
        self.assertAlmostEqual(faenza['x'], radar.VIEW_HALF, delta=1)
        self.assertAlmostEqual(faenza['y'], radar.VIEW_HALF, delta=1)


@unittest.skipUnless(HAVE_NUMPY, 'numpy e Pillow non installati')
class RadarNowcastTest(unittest.TestCase):
    """Movimento e stima su campi sintetici: una macchia di pioggia a ovest che va verso est."""

    @staticmethod
    def blob(cx, cy, n=201, r=12, mmh=4.0):
        import numpy as np
        yy, xx = np.mgrid[0:n, 0:n]
        return np.where((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r, mmh, 0.0).astype(np.float32)

    def test_motion_and_arrival(self):
        from server import radar
        c = radar.MOTION_HALF
        # 40 km/h verso est = 10 px in 15 minuti; ora la macchia è 30 km a ovest di Faenza
        older, newer = self.blob(c - 40, c), self.blob(c - 30, c)
        v = radar.motion(older, newer, 15)
        self.assertAlmostEqual(v[0] * 60, 40, delta=4)
        self.assertAlmostEqual(v[1] * 60, 0, delta=4)
        steps = {s['min']: s for s in radar.nowcast(newer, v)}
        self.assertEqual(steps[0]['frac'], 0.0)
        self.assertGreaterEqual(steps[45]['frac'], radar.ARRIVE_FRAC)  # 30 km a 40 km/h
        self.assertEqual(radar.nearest(newer)['dir'], 'ovest')

    def test_no_rain(self):
        import numpy as np
        from server import radar
        dry = np.zeros((201, 201), np.float32)
        self.assertIsNone(radar.motion(dry, dry, 15))
        self.assertIsNone(radar.nearest(dry))
        self.assertEqual([s['min'] for s in radar.nowcast(dry, None)], [0])

    def test_png_and_pack(self):
        import numpy as np
        from server import radar
        g = self.blob(100, 100)
        g[:5, :5] = np.nan
        png = radar.render_png(radar.window(g, 100, 100, radar.VIEW_HALF))
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        back = radar.unpack(radar.pack(g))
        self.assertTrue(np.isnan(back[0, 0]))
        self.assertAlmostEqual(float(back[100, 100]), 4.0, places=2)


class RiversTest(unittest.TestCase):
    """Livelli dei fiumi: composizione di api/rivers dai valori salvati (senza rete)."""

    def test_compose(self):
        from server import rivers
        old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'rivers.db'
        try:
            conn = db.connect()
            meta = {str(st['id']): {'name': st['name'], 's': [1.0, 2.0, 3.0]}
                    for r in sources.RIVERS for st in r['stations']}
            db.put_snapshot(conn, 'rivers', meta)
            t0 = 1791600000000
            faenza = sources.RIVERS[0]['stations'][-1]['id']
            for k in range(9):  # due ore ogni 15 minuti; Faenza sale da 0,5 a 1,3 m
                for r in sources.RIVERS:
                    for st in r['stations']:
                        v = 0.5 + 0.1 * k if st['id'] == faenza else 0.2
                        conn.execute('INSERT INTO river_levels VALUES (?, ?, ?)', (st['id'], t0 + k * 900000, v))
            conn.commit()
            d = rivers.compose(conn)
            lamone = d['rivers'][0]
            x = lamone['stations'][-1]
            self.assertEqual(x['name'], 'Faenza')
            self.assertAlmostEqual(x['v'], 1.3)
            self.assertEqual(x['level'], 1)  # soglia 1 superata
            self.assertAlmostEqual(x['trend'], 0.4)  # +0,4 m nell'ultima ora
            self.assertEqual(lamone['level'], 1)
            self.assertEqual(d['rivers'][1]['level'], 0)
            self.assertEqual(len(x['series']), 9)
            conn.close()
        finally:
            config.DB_PATH = old
