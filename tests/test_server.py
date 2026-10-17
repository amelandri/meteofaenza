"""Test del server (senza rete): python3 -m unittest discover -s tests"""

import json
import os
import re
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
        # azzeramento riconosciuto dal cambio di giorno della centralina (01:00 con l'ora legale)
        before = {'rainToday': 1.0, 'time': 1791500400000 - 60_000}  # 9/10 00:59 ora solare
        after = {'rainToday': 0.6, 'time': 1791500400000 + 540_000}
        self.assertEqual(self.verify.rain_step(before, after), 0.6)

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
        # Due giorni prima: il limite sono le 23 del 29, la previsione del 30 alle 9 non vale.
        self.assertIsNone(self.verify.forecast_day(self.conn, self.DAY, 2)['eu'])

    def test_cutoff_at_23(self):
        """Il giorno prima conta la previsione disponibile alle 23: una scaricata alle 23:30
        non vale."""
        from datetime import datetime
        from zoneinfo import ZoneInfo
        old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'cutoff.db'
        try:
            conn = db.connect()
            times = [f'2026-10-0{d}T{h:02d}:00' for d in (4, 5) for h in range(24)] + ['2026-10-06T00:00']
            ms = lambda h, m: int(datetime(2026, 10, 4, h, m, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)  # noqa: E731
            for init, at, mm in ((300, ms(16, 0), 1.0), (400, ms(23, 30), 5.0)):
                fc = _forecast(times, ['2026-10-04', '2026-10-05'])
                fc['hourly']['models']['eu']['precipitation'] = [mm] * len(times)
                self.verify.archive_forecast(conn, fc, {'eu': {'init': init}}, at)
            f = self.verify.forecast_day(conn, '2026-10-05', 1)
            self.assertEqual(f['eu']['runInit'], 300)
            self.assertEqual(f['eu']['rain'][12], 1.0)
            conn.close()
        finally:
            config.DB_PATH = old

    def test_dst_autumn_25_hours(self):
        """25/10/2026: 25 ore. Le due ore 02:00 si sommano, nessuna ora va persa."""
        from datetime import datetime, timedelta, timezone
        conn = db.connect()
        start = datetime(2026, 10, 24, 22, tzinfo=timezone.utc)  # mezzanotte locale (CEST)
        mm = 0.0
        solar = timezone(timedelta(hours=1))
        prev_day = None
        for k in range(25 * 6 + 1):  # una lettura ogni 10 minuti, 0,2 mm all'ora
            t = start + timedelta(minutes=10 * k, seconds=20)
            if k:
                mm += 0.2 / 6
            if prev_day is not None and t.astimezone(solar).date() != prev_day:
                mm = 0.2 / 6  # azzeramento a mezzanotte dell'ora solare, poi la pioggia continua
            prev_day = t.astimezone(solar).date()
            r = sources.parse_station(STATION_JS, fetched_at=1)
            r.update(time=int(t.timestamp() * 1000), rainToday=round(mm, 3), temperature=10.0)
            db.put_station(conn, r)
        obs = self.verify.observed_day(conn, '2026-10-25')
        self.assertAlmostEqual(obs['total'], 5.0, places=1)
        self.assertAlmostEqual(obs['rain'][1], 0.4, places=1)  # le due ore 02:00
        self.assertAlmostEqual(sum(obs['rain']), 5.0, places=1)
        self.assertTrue(obs['complete'])
        conn.close()

    def test_dst_spring_23_hours(self):
        """29/03/2026: 23 ore; l'ora 02:00 non esiste e vale 0."""
        from datetime import datetime, timedelta, timezone
        conn = db.connect()
        start = datetime(2026, 3, 28, 23, tzinfo=timezone.utc)  # mezzanotte locale (CET)
        mm = 0.0
        for k in range(23 * 6 + 1):
            t = start + timedelta(minutes=10 * k, seconds=20)
            if k:
                mm += 0.2 / 6
            r = sources.parse_station(STATION_JS, fetched_at=1)
            r.update(time=int(t.timestamp() * 1000), rainToday=round(mm, 3), temperature=10.0)
            db.put_station(conn, r)
        obs = self.verify.observed_day(conn, '2026-03-29')
        self.assertEqual(obs['rain'][1], 0.0)  # ora 01–02 → etichetta 02:00, saltata
        self.assertAlmostEqual(sum(obs['rain']), 4.6, places=1)
        self.assertTrue(obs['complete'])
        conn.close()

    def test_forecast_across_dst(self):
        """Previsione scaricata con l'ora legale (+2 h per tutta la risposta) per il 26/10:
        "13:00" archiviato è in realtà le 12:00 locali (ora solare)."""
        from datetime import datetime
        from zoneinfo import ZoneInfo
        conn = db.connect()
        times = [f'2026-10-{d}T{h:02d}:00' for d in (24, 25, 26) for h in range(24)] + ['2026-10-27T00:00', '2026-10-27T01:00']
        fc = _forecast(times, ['2026-10-24', '2026-10-25', '2026-10-26'])
        fc['hourly']['models']['eu']['precipitation'] = [1.0 if t == '2026-10-26T13:00' else 0.0 for t in times]
        issued = int(datetime(2026, 10, 24, 9, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)
        self.verify.archive_forecast(conn, fc, {'eu': {'init': 999}}, issued)
        f = self.verify.forecast_day(conn, '2026-10-26', 2)
        self.assertEqual(f['eu']['rain'][11], 1.0)  # ora 11–12 locale
        self.assertEqual(sum(f['eu']['rain']), 1.0)
        conn.close()

    def test_thin_ensemble_archive(self):
        """Dei giorni passati resta solo l'ultimo download dell'ensemble prima delle 23 (quello
        che la verifica usa); quelli di oggi restano tutti."""
        from datetime import datetime
        from zoneinfo import ZoneInfo
        old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'thin.db'
        try:
            conn = db.connect()
            ms = lambda d, h: int(datetime(2026, 10, d, h, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)  # noqa: E731
            # 10/10 alle 23: conta già per il giorno dopo (limite delle 23 dell'11)
            issued = [ms(10, 3), ms(10, 21), ms(10, 23), ms(11, 15), ms(12, 3), ms(12, 9)]
            for t in issued:
                conn.execute('INSERT INTO ensemble_archive VALUES (?, ?, ?, ?, ?)', (t, '2026-10-13T12:00', 'X', 1, 1))
            conn.commit()
            dropped = self.verify.thin_ensemble_archive(conn, now_ms=ms(12, 10))
            left = [r[0] for r in conn.execute('SELECT issued_at FROM ensemble_archive ORDER BY issued_at')]
            self.assertEqual(dropped, 2)
            self.assertEqual(left, [ms(10, 21), ms(11, 15), ms(12, 3), ms(12, 9)])
            conn.close()
        finally:
            config.DB_PATH = old

    def test_compose(self):
        res = self.verify.compose_verify(self.conn, 120, 1)
        self.assertEqual(res['lead'], 1)
        self.assertIn(self.DAY, [d['day'] for d in res['days']])

    def test_outcomes(self):
        v = self.verify
        self.assertEqual([v.outcome(1.0, 2.0), v.outcome(0.0, 0.1), v.outcome(0.2, 0.0), v.outcome(0.1, 0.4)],
                         ['hit', 'ok', 'false', 'miss'])
        self.assertIsNone(v.outcome(None, 1.0))
        self.assertEqual(v.qty_off(1.0, 6.0), 'more')
        self.assertEqual(v.qty_off(8.0, 2.5), 'less')
        self.assertIsNone(v.qty_off(1.0, 2.5))  # scarto sotto i 2 mm
        self.assertIsNone(v.qty_off(0.0, 6.0))  # non è "prevista e caduta"
        # due gruppi: 2 su 4 bagnati in almeno un'ora, 1 su 2; media 50% e 50% → 50
        ens = {'groups': [{'masks': [0b0001, 0b0010], 'n': [4, 4]}, {'masks': [0b01, 0], 'n': [2, 2]}]}
        self.assertEqual(v.chance(ens, [0, 1]), 50)
        self.assertIsNone(v.chance({'groups': [{'masks': [0, None], 'n': [4, 0]}]}, [0, 1]))

    def test_store_days(self):
        """Gli esiti dei giorni conclusi si salvano una volta (verify_days) e api/verify li
        legge senza ricalcolarli; --force li rielabora; oltre VERIFY_KEEP_DAYS si tolgono."""
        import json
        from datetime import datetime
        from zoneinfo import ZoneInfo
        times = [f'2026-09-30T{h:02d}:00' for h in range(24)] + [f'2026-10-01T{h:02d}:00' for h in range(24)] + ['2026-10-02T00:00']
        fc = _forecast(times, ['2026-09-30', '2026-10-01'])
        fc['hourly']['models']['eu']['precipitation'] = [0.4] * len(times)
        issued = int(datetime(2026, 9, 30, 9, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)
        self.verify.archive_forecast(self.conn, fc, {'i2i': {'init': 100}, 'eu': {'init': 200}}, issued)
        now = int(datetime(2026, 10, 3, 12, tzinfo=ZoneInfo('Europe/Rome')).timestamp() * 1000)
        self.conn.execute('DELETE FROM verify_days')
        self.assertGreaterEqual(self.verify.store_days(self.conn, now_ms=now), 2)  # 1/10 con anticipo 1 e 2 (e altri giorni dei test)
        self.assertEqual({r[0] for r in self.conn.execute('SELECT lead FROM verify_days WHERE day = ?', (self.DAY,))}, {1, 2})
        self.assertEqual(self.verify.store_days(self.conn, now_ms=now), 0)  # già salvati
        row = self.conn.execute("SELECT data FROM verify_days WHERE day = ? AND lead = 1", (self.DAY,)).fetchone()
        d = json.loads(row['data'])
        # sera senza misura: nei dati di prova manca la lettura delle 00:00 del giorno dopo
        self.assertEqual(d['observed']['slots'], [0.0, 0.5, 1.0, None])
        eu = d['models']['eu']
        self.assertEqual([c['res'] for c in eu['slots']], ['false', 'hit', 'hit', None])
        self.assertEqual(eu['day'], {'fc': 9.6, 'res': 'hit', 'qty': 'less'})
        # api/verify legge l'esito salvato, non lo ricalcola
        d['models']['eu']['day']['res'] = 'segno'
        self.conn.execute("UPDATE verify_days SET data = ? WHERE day = ? AND lead = 1", (json.dumps(d), self.DAY))
        self.conn.commit()
        res = self.verify.compose_verify(self.conn, 120, 1)
        self.assertEqual(next(x for x in res['days'] if x['day'] == self.DAY)['models']['eu']['day']['res'], 'segno')
        self.assertGreaterEqual(self.verify.store_days(self.conn, force=True, now_ms=now), 2)
        row = self.conn.execute("SELECT data FROM verify_days WHERE day = ? AND lead = 1", (self.DAY,)).fetchone()
        self.assertEqual(json.loads(row['data'])['models']['eu']['day']['res'], 'hit')
        # pulizia: oltre i due anni l'esito si toglie
        self.conn.execute("INSERT INTO verify_days VALUES ('2020-01-01', 1, 0, '{}')")
        db.prune_archives(self.conn)
        self.assertIsNone(self.conn.execute("SELECT 1 FROM verify_days WHERE day = '2020-01-01'").fetchone())
        self.assertIsNotNone(self.conn.execute('SELECT 1 FROM verify_days WHERE day = ?', (self.DAY,)).fetchone())


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

    def test_trend_after_gap(self):
        """Dopo un buco di ore nei dati niente tendenza (non una falsa salita rapida)."""
        from server import rivers
        old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'rivers-gap.db'
        try:
            conn = db.connect()
            meta = {str(st['id']): {'name': st['name'], 's': [1.0, 2.0, 3.0]}
                    for r in sources.RIVERS for st in r['stations']}
            db.put_snapshot(conn, 'rivers', meta)
            t0 = 1791600000000
            for r in sources.RIVERS:
                for st in r['stations']:
                    conn.execute('INSERT INTO river_levels VALUES (?, ?, ?)', (st['id'], t0, 0.5))
                    conn.execute('INSERT INTO river_levels VALUES (?, ?, ?)', (st['id'], t0 + 5 * 3600000, 0.9))
            conn.commit()
            x = rivers.compose(conn)['rivers'][0]['stations'][-1]
            self.assertIsNone(x['trend'])
            conn.close()
        finally:
            config.DB_PATH = old


class BackupTest(unittest.TestCase):
    """Job backup: copia compressa e leggibile, restano solo le ultime BACKUP_KEEP."""

    def test_backup(self):
        import gzip
        import sqlite3
        from server import jobs
        old = (config.DB_PATH, config.BACKUP_DIR, config.BACKUP_KEEP)
        config.DB_PATH = Path(_tmp.name) / 'backup-src.db'
        config.BACKUP_DIR = Path(_tmp.name) / 'backup'
        config.BACKUP_KEEP = 2
        try:
            conn = db.connect()
            db.put_snapshot(conn, 'normals', {'x': 1})
            config.BACKUP_DIR.mkdir()
            for name in ('meteo-20260101-0450.db.gz', 'meteo-20260102-0450.db.gz'):
                (config.BACKUP_DIR / name).write_bytes(b'')
            jobs.job_backup(conn)
            conn.close()
            files = sorted(p.name for p in config.BACKUP_DIR.iterdir())
            self.assertEqual(len(files), 2)  # la più vecchia tolta, niente file temporanei
            self.assertEqual(files[0], 'meteo-20260102-0450.db.gz')
            copy = Path(_tmp.name) / 'restored.db'
            copy.write_bytes(gzip.decompress((config.BACKUP_DIR / files[1]).read_bytes()))
            back = sqlite3.connect(copy)
            row = back.execute("SELECT data FROM snapshots WHERE name = 'normals'").fetchone()
            back.close()
            self.assertIn('"x"', row[0])
        finally:
            config.DB_PATH, config.BACKUP_DIR, config.BACKUP_KEEP = old


class CloudsTest(unittest.TestCase):
    """Nuvolosità osservata (server/clouds.py): METAR, radiazione della centralina, stima."""

    @classmethod
    def setUpClass(cls):
        from server import clouds
        cls.clouds = clouds
        cls.old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'clouds.db'
        cls.conn = db.connect()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        config.DB_PATH = cls.old

    def test_parse_metar(self):
        p = self.clouds.parse_metar
        base = {'icaoId': 'LIPE', 'obsTime': 1792228800}
        self.assertEqual(p({**base, 'cover': 'CLR', 'clouds': [], 'rawOb': 'METAR LIPE ... NSC'})['cover'], 0)
        self.assertEqual(p({**base, 'clouds': [{'cover': 'FEW', 'base': 3000}, {'cover': 'BKN', 'base': 1200}]})['cover'], 75)
        self.assertEqual(p({**base, 'clouds': [{'cover': 'VV', 'base': 100}]})['cover'], 100)  # nebbia
        self.assertEqual(p({**base, 'rawOb': 'METAR LIPC 170855Z 27003KT CAVOK 18/15 Q1018'})['cover'], 0)
        self.assertIsNone(p({**base, 'cover': '', 'clouds': []})['cover'])  # non riportata
        self.assertIsNone(p({'icaoId': 'LIPE'}))
        self.assertEqual(p(base)['time'], 1792228800000)

    def test_sun(self):
        c = self.clouds
        self.assertAlmostEqual(c.clear_sky(30), 488, delta=2)
        self.assertEqual(c.clear_sky(-5), 0)
        self.assertEqual([c.cover_from_k(k) for k in (1.1, 0.95, 0.62, 0.3, 0.1)], [0, 0, 51, 100, 100])

    def test_estimate(self):
        c = self.clouds
        c._cal.update(at=0, value=1.0)
        now = 1792230900000
        conn = self.conn
        # Di giorno, sole a 35°: metà della radiazione attesa a cielo sereno → nuvoloso
        clear = c.clear_sky(35)
        for k, minutes in ((0.5, 20), (0.5, 10), (0.5, 0)):
            db.put_station(conn, {'time': now - minutes * 60000, 'fetchedAt': now, 'temperature': 15,
                                  'radiation': clear * k, 'sunAltitude': 35})
        st = db.latest_station(conn)
        e = c.estimate(conn, st, now)
        self.assertEqual((e['source'], e['kind']), ('sun', 'total'))
        self.assertEqual(e['cover'], c.cover_from_k(0.5 / c.calibration(conn, now / 1000)))
        # Sole basso: si passa al METAR più vicino ancora recente (solo nubi basse: "almeno")
        db.put_metar(conn, [{'icao': 'LIPK', 'time': now - 100 * 60000, 'cover': 100, 'raw': 'vecchio'},
                            {'icao': 'LIPE', 'time': now - 20 * 60000, 'cover': 75, 'raw': 'METAR LIPE BKN012'}])
        low = {**st, 'sunAltitude': 5}
        e = c.estimate(conn, low, now)
        self.assertEqual((e['source'], e['kind'], e['cover'], e['station']), ('metar', 'min', 75, 'Bologna'))
        # Niente di recente: nessuna stima
        self.assertIsNone(c.estimate(conn, low, now + 3 * 3600 * 1000))


class AuthTest(unittest.TestCase):
    """Accesso (server/auth.py): password solo come hash, sessioni, token personali, API protette."""

    @classmethod
    def setUpClass(cls):
        from server import auth
        cls.auth = auth
        cls.old = config.DB_PATH
        config.DB_PATH = Path(_tmp.name) / 'auth.db'
        cls.conn = db.connect()
        auth.add_user(cls.conn, 'mario', 'password-lunga')

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        config.DB_PATH = cls.old

    def test_password_hash(self):
        stored = self.conn.execute("SELECT pw_hash FROM users WHERE username = 'mario'").fetchone()[0]
        self.assertNotIn('password-lunga', stored)
        self.assertTrue(stored.startswith(('scrypt$', 'pbkdf2$')))
        self.assertTrue(self.auth.check_password('password-lunga', stored))
        self.assertFalse(self.auth.check_password('password-lungA', stored))
        # stessa password, sale diverso: hash diversi
        self.assertNotEqual(self.auth.hash_password('abc12345'), self.auth.hash_password('abc12345'))
        self.assertEqual(self.auth.authenticate(self.conn, 'mario', 'password-lunga'), 'mario')
        self.assertIsNone(self.auth.authenticate(self.conn, 'mario', 'sbagliata'))
        self.assertIsNone(self.auth.authenticate(self.conn, 'nessuno', 'password-lunga'))
        with self.assertRaises(ValueError):
            self.auth.add_user(self.conn, 'corta', '1234')
        with self.assertRaises(ValueError):
            self.auth.add_user(self.conn, 'mario', 'altra-password')

    def test_sessions_and_tokens(self):
        a = self.auth
        tok = a.create_session(self.conn, 'mario')
        self.assertEqual(a.check_token(self.conn, tok), ('mario', False))
        stored = [r[0] for r in self.conn.execute('SELECT token_hash FROM sessions')]
        self.assertNotIn(tok, stored)  # nel database solo l'hash
        # dopo più di un giorno la sessione si rinnova
        self.conn.execute('UPDATE sessions SET renewed_at = renewed_at - ? WHERE kind = ?', (2 * 86400000, 'session'))
        self.assertEqual(a.check_token(self.conn, tok), ('mario', True))
        # scaduta
        self.conn.execute("UPDATE sessions SET expires_at = 1 WHERE kind = 'session'")
        self.assertEqual(a.check_token(self.conn, tok), (None, False))
        a.prune(self.conn)
        # token personale: senza scadenza, revocabile
        pt = a.create_token(self.conn, 'mario', 'test')
        self.assertEqual(a.check_token(self.conn, pt)[0], 'mario')
        a.revoke(self.conn, 'mario', tokens_only=True)
        self.assertIsNone(a.check_token(self.conn, pt)[0])
        # cambio password: chiude le sessioni
        s2 = a.create_session(self.conn, 'mario')
        a.set_password(self.conn, 'mario', 'password-lunga')
        self.assertIsNone(a.check_token(self.conn, s2)[0])

    def test_api(self):
        import http.client
        import threading
        from server import api
        srv = api.ThreadingHTTPServer(('127.0.0.1', 0), api.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]

        def req(method, path, body=None, headers=None):
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            h = {'X-Forwarded-For': '203.0.113.7', **(headers or {})}  # come da nginx
            if body is not None:
                h['Content-Type'] = 'application/json'
            c.request(method, path, body=body, headers=h)
            r = c.getresponse()
            data, cookie = r.read(), r.getheader('Set-Cookie')
            c.close()
            return r.status, data, cookie

        try:
            self.assertEqual(req('GET', '/api/station')[0], 401)
            self.assertEqual(req('GET', '/api/status')[0], 401)  # da nginx: serve l'accesso
            st, _, _ = req('GET', '/api/status', headers={'X-Forwarded-For': ''})
            self.assertNotEqual(st, 401)  # curl diretto sul server
            self.assertEqual(req('POST', '/api/login', '{"username":"mario","password":"no"}')[0], 401)
            st, body, cookie = req('POST', '/api/login', '{"username":"mario","password":"password-lunga"}',
                                   {'X-Forwarded-Proto': 'https'})
            self.assertEqual(st, 200)
            for part in ('meteo_session=', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/'):
                self.assertIn(part, cookie)
            # con la sessione il segnale leggibile da JavaScript (js/auth-guard.js), non HttpOnly
            self.assertIn('meteo_auth=1; Path=/; Max-Age=', cookie)
            self.assertNotIn('HttpOnly', cookie.split('meteo_auth=')[1])
            sess = cookie.split(';')[0]
            mark = 'meteo_auth=1'
            st, body, set_c = req('GET', '/api/me', headers={'Cookie': sess})
            self.assertEqual((st, json.loads(body)['user']), (200, 'mario'))
            self.assertIn('meteo_auth=1', set_c)  # sessione senza segnale (nata prima): lo rimette
            self.assertIsNone(req('GET', '/api/me', headers={'Cookie': f'{sess}; {mark}'})[2])
            pt = self.auth.create_token(self.conn, 'mario', 'swiftbar')
            st, _, set_c = req('GET', '/api/me', headers={'Authorization': f'Bearer {pt}'})
            self.assertEqual((st, set_c), (200, None))  # token personale: nessun cookie
            # segnale rimasto senza sessione valida: il server lo toglie
            st, _, set_c = req('GET', '/api/me', headers={'Cookie': f'meteo_session=finto; {mark}'})
            self.assertEqual(st, 401)
            self.assertIn('meteo_auth=; Path=/; Max-Age=0', set_c)
            # preferenze per utente: all'inizio nessuna, poi salvate e rilette
            st, body, _ = req('GET', '/api/settings', headers={'Cookie': sess})
            self.assertEqual((st, json.loads(body)['settings']), (200, None))
            st, body, _ = req('POST', '/api/settings', '{"settings":{"theme":"dark","verifyLead":2,"radarOpen":1,"x":5}}', {'Cookie': sess})
            out = json.loads(body)
            self.assertEqual(out['settings'], {'theme': 'dark', 'verifyLead': 2})
            self.assertEqual(sorted(out['ignored']), ['radarOpen', 'x'])  # 1 non è true
            st, body, _ = req('GET', '/api/settings', headers={'Cookie': sess})
            self.assertEqual(json.loads(body)['settings'], {'theme': 'dark', 'verifyLead': 2})
            self.assertEqual(req('POST', '/api/settings', '{"settings":{"theme":"light"}}')[0], 401)
            # solo JSON
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            c.request('POST', '/api/login', body='username=mario', headers={'Content-Type': 'application/x-www-form-urlencoded'})
            self.assertEqual(c.getresponse().status, 415)
            c.close()
            # logout: la sessione non vale più
            _, _, set_c = req('POST', '/api/logout', '{}', {'Cookie': sess})
            self.assertIn('meteo_session=; Path=/; Max-Age=0', set_c)
            self.assertIn('meteo_auth=; Path=/; Max-Age=0', set_c)
            self.assertEqual(req('GET', '/api/me', headers={'Cookie': sess})[0], 401)
            # cambio della password: serve quella attuale; chiude le altre sessioni e ne dà una
            # nuova a questo browser
            _, _, cookie = req('POST', '/api/login', '{"username":"mario","password":"password-lunga"}')
            s1 = cookie.split(';')[0]
            _, _, cookie = req('POST', '/api/login', '{"username":"mario","password":"password-lunga"}')
            s2 = cookie.split(';')[0]  # un altro dispositivo
            pw = lambda cur, new: req('POST', '/api/password', json.dumps({'current': cur, 'new': new}), {'Cookie': s1})
            self.assertEqual(req('POST', '/api/password', '{"current":"password-lunga","new":"nuova-password"}')[0], 401)
            st, body, _ = pw('sbagliata', 'nuova-password')
            self.assertEqual((st, json.loads(body)['error']), (403, 'la password attuale non è corretta'))
            self.assertEqual(pw('password-lunga', 'corta')[0], 400)
            self.assertEqual(pw('password-lunga', 'password-lunga')[0], 400)
            st, _, cookie = pw('password-lunga', 'nuova-password')
            self.assertEqual(st, 200)
            self.assertIn('meteo_auth=1', cookie)
            s3 = re.search(r'meteo_session=[^;]+', cookie).group(0)  # il primo Set-Cookie può essere il segnale
            self.assertEqual(req('GET', '/api/me', headers={'Cookie': s3})[0], 200)
            self.assertEqual(req('GET', '/api/me', headers={'Cookie': s1})[0], 401)
            self.assertEqual(req('GET', '/api/me', headers={'Cookie': s2})[0], 401)
            self.assertEqual(req('POST', '/api/login', '{"username":"mario","password":"nuova-password"}')[0], 200)
            self.auth.set_password(self.conn, 'mario', 'password-lunga')  # per gli altri test
            # troppi tentativi dallo stesso indirizzo
            for _ in range(self.auth.MAX_FAILURES):
                req('POST', '/api/login', '{"username":"mario","password":"no"}', {'X-Forwarded-For': '198.51.100.9'})
            self.assertEqual(req('POST', '/api/login', '{"username":"mario","password":"password-lunga"}',
                                 {'X-Forwarded-For': '198.51.100.9'})[0], 429)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_prefs(self):
        from server import prefs
        self.assertTrue(prefs.valid('verifyDays', 30))
        self.assertFalse(prefs.valid('verifyDays', '30'))
        self.assertFalse(prefs.valid('hourlyOpen', 0))  # 0 non è false
        self.assertFalse(prefs.valid('theme', 'blu'))
        saved, ignored = prefs.update(self.conn, 'mario', {'models': 'eu', 'range': 72})
        self.assertEqual((saved.get('models'), ignored), ('eu', ['range']))
        saved, _ = prefs.update(self.conn, 'mario', {'range': '24'})
        self.assertEqual((saved['models'], saved['range']), ('eu', '24'))  # unite, non sostituite
