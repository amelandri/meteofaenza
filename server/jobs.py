"""Job di aggiornamento, lanciati da cron (vedi deploy/crontab):

  python3 -m server.jobs station            centralina (ogni 10 minuti)
  python3 -m server.jobs forecast [--force] previsioni ed ensemble (controllo ogni 15 minuti)
  python3 -m server.jobs normals  [--force] esiti della verifica, pulizia degli archivi e medie
                                            del periodo (giornaliero)
  python3 -m server.jobs radar    [--force] radar della Protezione Civile (ogni 5 minuti)
  python3 -m server.jobs rivers           livelli di Lamone e Marzeno (ogni 15 minuti)
  python3 -m server.jobs verify   [--force] solo gli esiti della verifica (a mano; --force li
                                            rielabora tutti dove ci sono ancora le misure)
  python3 -m server.jobs backup             copia del database (ogni notte)
  python3 -m server.jobs all                tutti, forzati, tranne verify e backup (prima installazione)

Ogni job prende un lock: se il precedente è ancora in corso, quello nuovo esce subito.
Esito e dettagli finiscono nella tabella fetch_log (e in /api/status).
"""

import argparse
import fcntl
import gzip
import os
import shutil
import sqlite3
import sys
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

from . import auth, clouds, config, db, radar, rivers, sources, verify


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
    # Si riscrive solo se cambia: l'istante dello snapshot entra nella chiave della cache di
    # api/forecast, e riscriverlo ogni 15 minuti costringeva a ricomporre la risposta.
    if not old_runs or old_runs['data'] != merged:
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
            added = verify.archive_ensemble(conn, ens, ens['utcOffset'], issued)
            db.log(conn, 'ensemble', True, f'scaricato; archiviate {added} righe')
            notes.append(f'ensemble scaricato, {added} righe in archivio')
        except sources.SourceError as err:
            db.log(conn, 'ensemble', False, str(err))
            notes.append(f'ensemble non scaricato: {err}')
    return '; '.join(notes)


def job_normals(conn, force=False):
    """Job giornaliero: esiti della verifica dei giorni conclusi (prima della pulizia, così si
    calcolano finché ci sono le misure), manutenzione degli archivi (prima del download, così
    avviene anche se non riesce) e medie del periodo se mancano o sono vecchie."""
    saved = verify.store_days(conn)
    db.prune_archives(conn)
    auth.prune(conn)  # sessioni scadute
    thinned = verify.thin_ensemble_archive(conn)
    done = f'{saved} esiti della verifica salvati; archivi puliti ({thinned} download dell\'ensemble tolti)'
    at = db.snapshot_time(conn, 'normals')
    if not force and at and db.now_ms() - at < config.NORMALS_MAX_AGE_S * 1000:
        return f'medie già presenti; {done}'
    db.put_snapshot(conn, 'normals', sources.fetch_normals())
    return f'medie scaricate; {done}'


def job_verify(conn, force=False):
    """Esiti della verifica dei giorni conclusi che mancano (lo fa anche il job normals ogni
    giorno). Con --force rielabora tutti i giorni di cui ci sono ancora le misure, per esempio
    dopo un cambio delle regole."""
    return f'{verify.store_days(conn, force)} giorni salvati'


def job_radar(conn, force=False):
    detail = radar.run(conn, force)
    db.prune(conn)
    return detail


def job_backup(conn, force=False):
    """Copia coerente del database con l'API di backup di SQLite (sicura con API e job in
    funzione: un cp del solo file perderebbe le scritture ancora nel WAL), controllata e
    compressa in BACKUP_DIR; restano le ultime BACKUP_KEEP copie."""
    folder = config.BACKUP_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(ZoneInfo(config.TIMEZONE)).strftime('%Y%m%d-%H%M')
    final = folder / f'meteo-{stamp}.db.gz'
    tmp_db = folder / '.backup.db'
    tmp_gz = folder / '.backup.db.gz'
    try:
        tmp_db.unlink(missing_ok=True)  # resto di un tentativo interrotto
        dest = sqlite3.connect(tmp_db)
        try:
            conn.backup(dest)
            check = dest.execute('PRAGMA quick_check').fetchone()[0]
        finally:
            dest.close()
        if check != 'ok':
            raise RuntimeError(f'copia non valida: {check}')
        with open(tmp_db, 'rb') as src, gzip.open(tmp_gz, 'wb') as out:
            shutil.copyfileobj(src, out)
        os.replace(tmp_gz, final)  # la copia compare solo se completa
    finally:
        tmp_db.unlink(missing_ok=True)
        tmp_gz.unlink(missing_ok=True)
    old = sorted(folder.glob('meteo-*.db.gz'))[:-config.BACKUP_KEEP]
    for path in old:
        path.unlink()
    size = final.stat().st_size / 1e6
    return f'{final.name} ({size:.1f} MB); {len(old)} copie vecchie tolte'


JOBS = {'station': job_station, 'forecast': job_forecast, 'normals': job_normals, 'radar': job_radar, 'rivers': rivers.run,
        'clouds': clouds.run,
        'verify': job_verify, 'backup': job_backup}
# Esclusi da "all" (prima installazione): non scaricano dati.
NOT_IN_ALL = {'backup', 'verify'}


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
    except (sources.SourceError, ImportError) as err:
        # ImportError: numpy o Pillow mancanti (servono solo al radar, vedi deploy/INSTALL.md)
        msg = f'librerie mancanti ({err})' if isinstance(err, ImportError) else str(err)
        db.log(conn, name, False, msg)
        print(f'{name}: errore: {msg}', file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001
        # Errori imprevisti (database occupato, formato della fonte cambiato, …): nel registro,
        # così api/status non continua a mostrare l'ultimo successo. Traccia completa nel log.
        msg = f'errore imprevisto: {type(err).__name__}: {err}'
        try:
            conn.rollback()
            db.log(conn, name, False, msg)
        except Exception:  # noqa: BLE001  (database non utilizzabile: resta il log di sistema)
            pass
        traceback.print_exc()
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
        return max(run(name, force=True) for name in JOBS if name not in NOT_IN_ALL)
    return run(args.job, args.force)


if __name__ == '__main__':
    sys.exit(main())
