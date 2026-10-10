# Installazione di Meteo Faenza su un server Linux

Guida per un server **Debian o Ubuntu** con accesso root, con il codice scaricato da git.
Dove compare `<…>` va inserito il proprio valore.

Architettura in breve:

```
fonti esterne ──(cron)──▶ server/jobs.py ──▶ SQLite ◀── server/api.py ◀──(nginx /api/)── browser
(Open-Meteo, centralina)                                                  nginx: file statici
```

| Componente | Dove | Note |
|---|---|---|
| Codice | `/opt/meteo` | proprietà di root, in sola lettura |
| Database e lock dei job | `/var/lib/meteo` | scrivibile solo dall'utente `meteo` |
| API | `127.0.0.1:8085` | servizio systemd `meteo-api`, non raggiungibile dall'esterno |
| Aggiornamento dei dati | crontab dell'utente `meteo` | centralina ogni 10 min, previsioni ogni 15 min (solo con nuovi run), medie ogni giorno (solo se mancano) |
| Sito | nginx | file statici + `/api/` verso l'API |

---

## 0. Prerequisito: codice sul repository

Il branch `server` deve essere stato pubblicato sul repository remoto. Dalla propria macchina di sviluppo:

```bash
git push -u origin server
```

## 1. Pacchetti

```bash
sudo apt update
sudo apt install -y git python3 nginx certbot python3-certbot-nginx
sudo apt install -y python3-numpy python3-pil   # solo per il job del radar
python3 --version        # serve 3.9 o successivo (Debian 11+, Ubuntu 22.04+)
python3 -c "import numpy, PIL; print('numpy', numpy.__version__, '· Pillow', PIL.__version__)"
```

Il server usa la libreria standard di Python; l'unica eccezione sono **numpy** e **Pillow**, usate solo dal job del radar (lettura delle immagini e calcolo del movimento della pioggia). Si installano dai pacchetti di Debian con `apt`, **non con `pip`** (su Debian 12 e successivi `pip install` sul Python di sistema è bloccato apposta): così le aggiorna `apt upgrade` insieme al resto e le vedono sia il servizio systemd sia cron, che usano il Python di sistema. Se mancassero, fallirebbe solo il job del radar.

## 2. Utente di servizio e cartella del database

```bash
sudo useradd --system --home /var/lib/meteo --shell /usr/sbin/nologin meteo
sudo mkdir -p /var/lib/meteo
sudo chown meteo:meteo /var/lib/meteo
```

## 3. Scaricare il codice

```bash
sudo git clone --branch server <URL-del-repository> /opt/meteo
```

Se il repository è privato, il server deve potervi accedere: per esempio con una *deploy key* SSH (URL `git@…`) o con un token in sola lettura (URL `https://…`).

Controllo veloce (non usa la rete né il database):

```bash
cd /opt/meteo && python3 -B -m unittest discover -s tests
```

## 4. Primo popolamento del database

```bash
sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db \
  sh -c 'cd /opt/meteo && python3 -B -m server.jobs all'
```

Deve stampare quattro righe: `station`, `forecast` (con l'ensemble) e `normals`.

Se `normals` risponde "troppe richieste (HTTP 429)", non è un problema: Open-Meteo limita le richieste all'archivio storico, e il job giornaliero riprova da solo il giorno dopo.

## 5. API come servizio systemd

```bash
sudo cp /opt/meteo/deploy/meteo-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meteo-api
systemctl status meteo-api                       # deve essere "active (running)"
curl -s http://127.0.0.1:8085/api/status         # stato dei job, in JSON
```

Per cambiare porta o percorso del database basta modificare le righe `Environment=` del file del servizio, poi `sudo systemctl daemon-reload && sudo systemctl restart meteo-api`. Se cambia la porta, va aggiornata anche la configurazione di nginx (passo 7).

## 6. Job di aggiornamento (cron)

```bash
sudo crontab -u meteo /opt/meteo/deploy/crontab
sudo crontab -u meteo -l                         # verifica
```

Il comando **sostituisce** l'eventuale crontab dell'utente `meteo`. Per un utente nuovo non c'è nulla da perdere.

Per seguire gli aggiornamenti in diretta:

```bash
journalctl -t meteo -f
```

Entro 5 minuti deve comparire una riga `radar:`, entro 10 una riga `station:`, entro 15 una riga `forecast:`.

| Job | Quando | Cosa fa |
|---|---|---|
| `station` | ogni 10 minuti, 20 s dopo lo scoccare | legge la centralina (meteofaenza.it) |
| `forecast` | minuti 2, 17, 32, 47 | controlla i metadati dei modelli; scarica le previsioni solo se è uscito un nuovo run (ICON-2I ogni 12 h, ICON-EU ogni 3 h) o se hanno più di 6 ore; ensemble ogni 3 ore |
| `radar` | ogni 5 minuti, 10 s dopo lo scoccare | scarica le immagini nuove del radar della Protezione Civile, calcola movimento e stima dei prossimi 90 minuti, prepara le immagini dell'animazione (richiede numpy e Pillow, passo 1) |
| `rivers` | minuti 7, 22, 37, 52 | livelli di Lamone e Marzeno (idrometri ARPAE, portale Allerta Meteo): soglie e serie delle ultime ~2,5 giorni, salvate nel database |
| `normals` | ogni giorno alle 4:40 | scarica le medie del periodo 1991–2020 solo se mancano o hanno più di un anno |

## 7. nginx

```bash
sudo cp /opt/meteo/deploy/nginx-meteo.conf /etc/nginx/sites-available/meteo
sudo nano /etc/nginx/sites-available/meteo       # inserire il proprio dominio in server_name
sudo ln -s /etc/nginx/sites-available/meteo /etc/nginx/sites-enabled/meteo
sudo rm -f /etc/nginx/sites-enabled/default      # solo se il server non ospita altri siti
sudo nginx -t && sudo systemctl reload nginx
```

La configurazione non espone `server/`, `data/`, `tests/`, `deploy/`, `swiftbar/`, i file nascosti e i file `.py`, `.md` e `.db`.

Per installare l'app in una **sottocartella** di un sito esistente (es. `https://example.it/meteo/`), in fondo al file c'è una variante commentata, da inserire nel blocco `server { }` esistente.

## 8. HTTPS

Il dominio deve già puntare all'indirizzo IP del server.

```bash
sudo certbot --nginx -d <tuo-dominio>
```

Certbot aggiunge da solo la porta 443 e i certificati, e ne programma il rinnovo automatico. L'HTTPS serve anche al service worker, cioè all'installazione come app e all'uso offline.

Se il server ha un firewall attivo:

```bash
sudo ufw allow 'Nginx Full'                      # porte 80 e 443 (la 8085 resta chiusa)
```

## 9. Verifiche finali

```bash
curl -s https://<tuo-dominio>/api/status         # stato dei job
curl -sI https://<tuo-dominio>/api/forecast      # 200 con ETag
curl -sI https://<tuo-dominio>/server/config.py  # deve rispondere 404 (codice non esposto)
```

Poi aprire il sito nel browser. In DevTools → Network non devono comparire richieste a domini esterni: solo `api/…` e i file dell'app.

---

## Aggiornare l'app

```bash
cd /opt/meteo
sudo git pull
sudo systemctl restart meteo-api                 # solo se è cambiato qualcosa in server/
```

- **Job:** cron li rilegge da solo a ogni esecuzione.
- **Frontend:** per le modifiche a HTML, JavaScript o CSS, prima del commit va incrementato `VERSION` in `sw.js`; altrimenti chi ha già aperto l'app continua a vedere la versione salvata nel browser.
- **Crontab o nginx:** se cambia `deploy/crontab` ripetere il passo 6; se cambia `deploy/nginx-meteo.conf`, il passo 7.

## Comandi utili

| Cosa | Comando |
|---|---|
| Log dell'API | `journalctl -u meteo-api` |
| Log dei job | `journalctl -t meteo` |
| Stato dei dati | `curl -s http://127.0.0.1:8085/api/status` |
| Forzare l'aggiornamento delle previsioni | `sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db sh -c 'cd /opt/meteo && python3 -B -m server.jobs forecast --force'` |
| Riavviare l'API | `sudo systemctl restart meteo-api` |
| Backup del database | `sudo -u meteo python3 -c "import sqlite3; s=sqlite3.connect('/var/lib/meteo/meteo.db'); s.backup(sqlite3.connect('/var/lib/meteo/backup.db'))"` |

Il database è piccolo: qualche centinaio di KB per previsioni e medie, più circa 1 KB per ogni lettura della centralina (conservate per circa 400 giorni).

## Problemi frequenti

| Sintomo | Causa probabile | Cosa fare |
|---|---|---|
| Il sito mostra "dati non ancora disponibili" | i job non hanno ancora girato | eseguire il passo 4, controllare `journalctl -t meteo` |
| `502 Bad Gateway` su `/api/` | l'API non è in esecuzione | `systemctl status meteo-api`, `journalctl -u meteo-api` |
| La centralina risulta "non aggiornata" | il job `station` fallisce o il sito della centralina non risponde | `journalctl -t meteo`; l'ultimo esito è anche in `api/status` |
| `normals: troppe richieste (HTTP 429)` | limite delle richieste all'archivio di Open-Meteo | nessuna azione: il job riprova il giorno dopo |
| Dopo un aggiornamento il browser mostra la versione vecchia | `VERSION` in `sw.js` non incrementato | incrementarlo, fare commit e `git pull` |
