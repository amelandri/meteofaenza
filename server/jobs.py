"""Job di aggiornamento, lanciati da cron (vedi deploy/crontab):

  python3 -m server.jobs station            centralina (ogni 10 minuti)
  python3 -m server.jobs forecast [--force] previsioni ed ensemble (controllo ogni 15 minuti)
  python3 -m server.jobs normals  [--force] medie del periodo (controllo giornaliero)
  python3 -m server.jobs all                tutti, forzati (prima installazione)

Ogni job prende un lock: se il precedente è ancora in corso, quello nuovo esce subito.
Esito e dettagli finiscono nella tabella fetch_log (e in /api/status).
"""

import argparse
import fcntl
import sys

from . import config, db, sources, verify


def _locked(name):
    """Lock esclusivo su un file: None se un altro job uguale è in corso."""
    path = config.DB_PATH.parent / f'.{name}.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, 'w')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except BlockingIOError:
        fh.close()
        return None


def job_station(conn, force=False):
    reading = sources.fetch_station()
    new = db.put_station(conn, reading)
    db.prune(conn)
    return f"misura delle {reading['time']} {'nuova' if new else 'già salvata'}"


def job_forecast(conn, force=False):
    """Controlla i metadati dei run (sempre, sono minuscoli) e scarica le previsioni solo se
    serve; l'ensemble a intervallo fisso. Restituisce un riepilogo per il registro."""
    notes = []
    runs = sources.fetch_runs()
    old_runs = db.get_snapshot(conn, 'runs')
    # Si tengono i metadati precedenti dei modelli che non hanno risposto.
    merged = {k: v or ((old_runs or {}).get('data') or {}).get(k) for k, v in runs.items()}
    db.put_snapshot(conn, 'runs', merged)

    fc = db.get_snapshot(conn, 'forecast')
    reason = None
    if force:
        reason = 'forzato'
    elif not fc:
        reason = 'nessuna previsione salvata'
    elif db.now_ms() - fc['fetched_at'] > config.FORECAST_MAX_AGE_S * 1000:
        reason = 'previsione con più di 6 ore'
    else:
        # Nuovo run: disponibile dopo il download della previsione salvata.
        for key, r in merged.items():
            if r and r.get('available') and r['available'] * 1000 > fc['fetched_at']:
                reason = f'nuovo run {key}'
                break
    if reason:
        try:
            fc = sources.fetch_forecast()
            issued = db.now_ms()
            db.put_snapshot(conn, 'forecast', fc, issued)
            # Archivio per la verifica: i run nuovi di ciascun modello (ore future).
            added = verify.archive_forecast(conn, fc, merged, issued)
            db.log(conn, 'forecast', True, f'scaricata ({reason}); archiviate {added} ore')
            notes.append(f'previsioni scaricate ({reason}), {added} ore in archivio')
        except sources.SourceError as err:
            db.log(conn, 'forecast', False, str(err))
            notes.append(f'previsioni non scaricate: {err}')
    else:
        notes.append('previsioni già aggiornate')

    ens_at = db.snapshot_time(conn, 'ensemble')
    if force or not ens_at or db.now_ms() - ens_at > config.ENSEMBLE_EVERY_S * 1000 - 60_000:
        try:
            ens = sources.fetch_ensemble()
            issued = db.now_ms()
            db.put_snapshot(conn, 'ensemble', ens, issued)
            utc_offset = ((db.get_snapshot(conn, 'forecast') or {}).get('data') or {}).get('utcOffset', 0)
            added = verify.archive_ensemble(conn, ens, utc_offset, issued)
            db.log(conn, 'ensemble', True, f'scaricato; archiviate {added} righe')
            notes.append(f'ensemble scaricato, {added} righe in archivio')
        except sources.SourceError as err:
            db.log(conn, 'ensemble', False, str(err))
            notes.append(f'ensemble non scaricato: {err}')
    return '; '.join(notes)


def job_normals(conn, force=False):
    at = db.snapshot_time(conn, 'normals')
    if not force and at and db.now_ms() - at < config.NORMALS_MAX_AGE_S * 1000:
        return 'medie già presenti'
    db.put_snapshot(conn, 'normals', sources.fetch_normals())
    return 'medie scaricate'


JOBS = {'station': job_station, 'forecast': job_forecast, 'normals': job_normals}


def run(name, force=False):
    lock = _locked(name)
    if not lock:
        print(f'{name}: già in corso, salto')
        return 0
    conn = db.connect()
    try:
        detail = JOBS[name](conn, force)
        # forecast registra da sé l'esito di previsioni ed ensemble
        if name != 'forecast':
            db.log(conn, name, True, detail)
        print(f'{name}: {detail}')
        return 0
    except sources.SourceError as err:
        db.log(conn, name, False, str(err))
        print(f'{name}: errore: {err}', file=sys.stderr)
        return 1
    finally:
        conn.close()
        lock.close()


def main(argv=None):
    p = argparse.ArgumentParser(description='Aggiornamento dei dati di Meteo Faenza')
    p.add_argument('job', choices=[*JOBS, 'all'])
    p.add_argument('--force', action='store_true', help='scarica anche se i dati sono aggiornati')
    args = p.parse_args(argv)
    if args.job == 'all':
        return max(run(name, force=True) for name in JOBS)
    return run(args.job, args.force)


if __name__ == '__main__':
    sys.exit(main())
