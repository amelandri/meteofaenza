"""Gestione degli utenti dell'app, solo dal server (l'app non permette di registrarsi):

  python3 -m server.users add <nome>                 crea un utente (chiede la password due volte)
  python3 -m server.users passwd <nome>              cambia la password (chiude le sessioni aperte)
  python3 -m server.users del <nome>                 elimina l'utente, le sue sessioni e i suoi token
  python3 -m server.users list                       elenca utenti e token personali
  python3 -m server.users token <nome> [--label L]   crea un token personale (es. plugin SwiftBar)
  python3 -m server.users revoke <nome> [--tokens]   chiude tutte le sessioni e revoca i token
                                                      (solo i token con --tokens)

Sul server, con il database di produzione:
  sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db sh -c 'cd /opt/meteo && python3 -m server.users add mario'

La password si digita senza che compaia sullo schermo e nel database finisce solo il suo hash
(vedi auth.py). Il token personale viene mostrato una volta sola: va copiato subito.
"""

import argparse
import getpass
import sys
from datetime import datetime

from . import auth, db


def _ask_password():
    p1 = getpass.getpass('Password: ')
    p2 = getpass.getpass('Ripeti la password: ')
    if p1 != p2:
        raise ValueError('le due password non coincidono')
    return p1


def _when(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%d/%m/%Y %H:%M') if ms else '—'


def main(argv=None):
    p = argparse.ArgumentParser(description='Utenti di Meteo Faenza')
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('add', 'passwd', 'del'):
        sub.add_parser(name).add_argument('username')
    sub.add_parser('list')
    t = sub.add_parser('token')
    t.add_argument('username')
    t.add_argument('--label', default='', help='a cosa serve (es. "SwiftBar Mac")')
    r = sub.add_parser('revoke')
    r.add_argument('username')
    r.add_argument('--tokens', action='store_true', help='revoca solo i token personali')
    args = p.parse_args(argv)

    conn = db.connect()
    try:
        if args.cmd == 'add':
            auth.add_user(conn, args.username, _ask_password())
            print(f'Utente "{args.username}" creato.')
        elif args.cmd == 'passwd':
            auth.set_password(conn, args.username, _ask_password())
            print(f'Password di "{args.username}" cambiata; le sessioni aperte sono state chiuse.')
        elif args.cmd == 'del':
            auth.delete_user(conn, args.username)
            print(f'Utente "{args.username}" eliminato.')
        elif args.cmd == 'list':
            users = auth.list_users(conn)
            if not users:
                print('Nessun utente: creane uno con "python3 -m server.users add <nome>".')
            for u in users:
                print(f'{u["username"]:<24} creato {_when(u["created_at"])}   ultimo accesso {_when(u["last_login"])}')
            tokens = auth.list_tokens(conn)
            if tokens:
                print('\nToken personali:')
                for tk in tokens:
                    print(f'  {tk["username"]:<22} {tk["label"] or "(senza nome)":<24} creato {_when(tk["created_at"])}')
        elif args.cmd == 'token':
            token = auth.create_token(conn, args.username, args.label)
            print('Token personale (mostrato una sola volta, copialo ora):\n')
            print(f'  {token}\n')
            print('Si usa con l\'intestazione "Authorization: Bearer <token>"; per il plugin SwiftBar,')
            print('nella variabile METEO_TOKEN o nel file ~/.config/meteo-faenza/token.')
        elif args.cmd == 'revoke':
            n = auth.revoke(conn, args.username, tokens_only=args.tokens)
            print(f'{n} {"token revocati" if args.tokens else "sessioni e token chiusi"} per "{args.username}".')
        return 0
    except ValueError as err:
        print(f'Errore: {err}.', file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print('\nAnnullato.', file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
