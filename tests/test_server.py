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

from server import api, db, sources  # noqa: E402

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
