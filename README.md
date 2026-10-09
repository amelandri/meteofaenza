# Meteo Faenza

Web app (PWA) che mette a confronto le previsioni di due modelli meteorologici per **Faenza** e le affianca alle misure reali della centralina cittadina:

- **ICON-2I**: modello ad alta risoluzione (2,2 km) di ItaliaMeteo-ARPAE, copre l'Italia per circa 3 giorni e mezzo;
- **ICON-EU**: modello europeo (7 km) del servizio meteorologico tedesco DWD, copre circa 5 giorni e mezzo;
- **Centralina**: Osservatorio Meteorologico "E. Torricelli" ([meteofaenza.it](https://www.meteofaenza.it/)).

È composta da un **frontend statico** (HTML, CSS e JavaScript senza passaggio di build) e da un **piccolo server in Python** (solo libreria standard) con un database **SQLite**. Il server scarica le fonti esterne a intervalli regolari, via cron, e le serve al frontend come API JSON. Così le fonti vengono interrogate una volta per tutti gli utenti e non da ogni browser. Non serve alcuna API key e non c'è login: le preferenze restano nel browser. Le previsioni vengono salvate anche nel browser e restano consultabili offline (fino a un giorno dal download).

## Cosa mostra

- **Adesso**: l'ultima misura della centralina (temperatura con minima e massima del giorno, umidità, vento, pioggia di oggi, raffica massima). Viene aggiornata ai minuti :00, :10, :20, :30, :40, :50. Se i millimetri di oggi aumentano tra una lettura e l'altra compare "sta piovendo".
- **Oggi, Domani, Dopodomani**: una scheda per giorno, con i due modelli a confronto:
  - riepilogo del giorno e suddivisione in quattro fasce (notte, mattina, pomeriggio, sera);
  - alba e tramonto; per ogni fascia anche la probabilità di pioggia;
  - un giudizio sulla **concordanza dei modelli** (concordi / lievi differenze / discordi), con il motivo;
  - **Bike**: per ogni intervallo del tragitto in bici (nome e fino a 6 "intervalli monitorati" configurabili nella pagina Impostazioni, ognuno con i giorni della settimana in cui vale, al massimo 3 nello stesso giorno; predefiniti 06:45–08:00, 12:30–15:00, 17:00–18:30, tutti i giorni), se pioverà (Asciutto, Rischio, Incerto, Pioggia) e con quale probabilità.
- **Andamento orario**: grafico che sovrappone i due modelli per precipitazioni (con la probabilità di pioggia ora per ora), temperatura, vento, nuvolosità, umidità e pressione. Nella temperatura due linee tratteggiate mostrano le previsioni corrette con la misura della centralina per le ore successive.
- **Dettaglio orario** (chiuso di default): tabella ora per ora con entrambi i modelli e la probabilità di pioggia.

Massima e minima (previste e misurate) sono confrontate con le **medie del periodo** 1991–2020: lo scarto compare accanto ai valori nelle card dei giorni e nel box Adesso, e il grafico della temperatura ha due linee punteggiate con massima e minima medie. Il server le scarica una volta e le aggiorna una volta l'anno.

Tutti gli orari sono nell'ora locale di Faenza.

La pagina **Impostazioni** (icona a ingranaggio) permette di scegliere il tema (automatico, chiaro o scuro), quali previsioni mostrare (entrambi i modelli, solo ICON-2I o solo ICON-EU; la probabilità di pioggia resta sempre visibile) e gli intervalli monitorati. La pagina **Come funziona** (icona "i") spiega modelli, ensemble, calcolo della probabilità e regole dei verdetti.

Il server controlla ogni 15 minuti se è uscito un nuovo run dei modelli e solo allora scarica le previsioni; legge la centralina ogni 10 minuti. Con l'app aperta, il browser ricontrolla il server ogni 10 minuti (e scarica i dati solo se sono cambiati).

### Come leggere i tragitti in bici

Per ogni intervallo l'app controlla se ciascun modello prevede almeno 0,2 mm di pioggia, e qual è la probabilità: la quota di scenari con almeno 0,2 mm nei due ensemble del DWD, ICON-EU-EPS (40 scenari, circa 5 giorni) e ICON-D2-EPS (20 scenari a 2,2 km, circa 2 giorni). Dove ci sono entrambi la probabilità è la media delle due.

| Verdetto | Quando |
|---|---|
| ☂ Pioggia | entrambi i modelli vedono pioggia e probabilità ≥ 30%, oppure uno solo e ≥ 60%, oppure probabilità ≥ 80%; oppure sta piovendo adesso secondo la centralina e il tragitto è in corso o inizia entro 30 minuti |
| ☀ Asciutto | nessun modello vede pioggia e probabilità < 20% |
| ☁ Rischio | nessun modello vede pioggia, ma probabilità ≥ 20% |
| ☁💧 Incerto | tutti gli altri casi |

Toccando un tragitto (o passandoci sopra con il mouse) si vede il dettaglio: millimetri per modello, probabilità e motivo del verdetto.

## Architettura

```
fonti esterne ──(cron)──▶ server/jobs.py ──▶ SQLite ◀── server/api.py ◀──(nginx /api/)── browser
(Open-Meteo, centralina)                                                  nginx: file statici
```

| Dato | Fonte | Aggiornamento sul server |
|---|---|---|
| Centralina | meteofaenza.it | ogni 10 minuti (20 s dopo lo scoccare) |
| Previsioni ICON-2I / ICON-EU | Open-Meteo | controllo dei metadati ogni 15 minuti; download solo se c'è un nuovo run (ICON-2I ogni 12 h, ICON-EU ogni 3 h) o se hanno più di 6 ore |
| Ensemble ICON-EU-EPS / ICON-D2-EPS | Open-Meteo | ogni 3 ore (i loro metadati non sono affidabili) |
| Metadati dei run | Open-Meteo | ogni 15 minuti (pochi byte) |
| Medie del periodo 1991–2020 | archivio Open-Meteo (ERA5-Land) | controllo giornaliero, download solo se mancano o hanno più di un anno |

In una giornata il server fa così circa 10 download di previsioni, 8 di ensemble e 144 letture della centralina, qualunque sia il numero di utenti. Prima ogni browser aperto scaricava previsioni ed ensemble ogni 30 minuti.

API (tutte in sola lettura, con `ETag`: il browser riscarica solo se i dati sono cambiati):

| Percorso | Contenuto |
|---|---|
| `api/forecast` | previsioni dei due modelli, ensemble e metadati dei run |
| `api/station` | ultima misura della centralina e letture delle ultime 2 ore |
| `api/normals` | medie del periodo |
| `api/status` | stato dei job (ultimo aggiornamento, errori) |

## Avvio in locale

Serve solo Python 3.9 o successivo, senza pacchetti aggiuntivi:

```bash
python3 -m server.jobs all          # primo popolamento del database (data/meteo.db)
python3 -m server.api --static      # API + file del frontend su http://127.0.0.1:8085
```

poi aprire <http://127.0.0.1:8085>. In locale i job si rilanciano a mano (`python3 -m server.jobs station`, `forecast`, `normals`). Test: `python3 -m unittest discover -s tests`.

Il service worker funziona solo su `http://localhost`/`127.0.0.1` o in HTTPS.

## Installazione sul server (Linux + nginx)

1. Codice in `/opt/meteo` (es. `git clone`), utente di servizio e cartella del database:
   ```bash
   useradd --system --home /var/lib/meteo meteo
   mkdir -p /var/lib/meteo && chown meteo:meteo /var/lib/meteo
   ```
2. Primo popolamento: `sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db sh -c 'cd /opt/meteo && python3 -m server.jobs all'`
3. API come servizio: `deploy/meteo-api.service` in `/etc/systemd/system/`, poi `systemctl enable --now meteo-api` (ascolta solo su `127.0.0.1:8085`).
4. Aggiornamenti: `crontab -u meteo deploy/crontab` (log con `journalctl -t meteo`).
5. nginx: `deploy/nginx-meteo.conf` in `/etc/nginx/sites-available/`, adattare `server_name`, collegare in `sites-enabled`, `nginx -t && systemctl reload nginx`; HTTPS con `certbot --nginx`. La configurazione non espone `server/`, `data/`, `tests/` e `deploy/`. Per installare l'app in una sottocartella c'è una variante commentata nello stesso file.

Controllo: `curl -s https://<dominio>/api/status`.

Dopo ogni modifica ai file del frontend va incrementato `VERSION` in `sw.js`: altrimenti chi ha già aperto l'app continua a vedere la versione salvata nel browser. Dopo una modifica al server: `systemctl restart meteo-api`.

## Installazione su telefono

L'app è una PWA: da Chrome o Edge si installa con l'icona nella barra degli indirizzi, da Safari su iPhone con *Condividi → Aggiungi alla schermata Home*.

## Personalizzazione

Tema, modelli mostrati e intervalli monitorati si scelgono dalla pagina Impostazioni. Il resto è nelle costanti del codice:

| Cosa | Dove |
|---|---|
| Località (nome, coordinate, quota) | `LOCATION` in `js/app.js` |
| Intervalli monitorati predefiniti | `DEFAULT_WATCH` in `js/storage.js` |
| Soglie del verdetto dei tragitti | `BIKE_WET_MM`, `BIKE_POP_BOTH`, `BIKE_POP_ONE`, `BIKE_POP_ANY`, `BIKE_POP_DRY` in `js/app.js` |
| Pioggia in corso dalla centralina | `RAIN_NOW_*` in `js/app.js` |
| Correzione della temperatura con la centralina | `TEMP_FIX_*` in `js/app.js` |
| Soglie della concordanza dei modelli | `AGREE` in `js/app.js` |
| Giorni mostrati in "Prossimi giorni" | `DAILY_DAYS` in `js/app.js` |
| Località per il server (coordinate) | `LAT`, `LON` in `server/config.py` |
| Ensemble usati per la probabilità | `ENSEMBLE_MODELS` in `server/sources.py` |
| Frequenza degli aggiornamenti del server | `deploy/crontab` e `*_MAX_AGE_S` / `ENSEMBLE_EVERY_S` in `server/config.py` |
| Ogni quanto il browser ricontrolla il server | `CACHE_TTL_MS` in `js/storage.js` |

Se si cambiano soglie o regole, va aggiornata anche la pagina `info.html`, che le riporta in chiaro.

La centralina è specifica di Faenza: cambiando località va sostituita o rimossa (`server/sources.py` e `js/station.js`).

## Struttura

```
index.html             pagina principale
info.html              pagina "Come funziona" (modelli, ensemble, calcolo della probabilità)
settings.html          pagina Impostazioni (tema, modelli mostrati, intervalli monitorati)
css/style.css          stile (tema chiaro e scuro)
js/theme.js            applica il tema scelto prima che la pagina compaia
js/app.js              logica e rendering
js/settings.js         pagina Impostazioni
js/api.js              accesso all'API del server (previsioni, centralina, medie)
js/station.js          misure della centralina (dall'API)
js/storage.js          salvataggio nel browser (localStorage)
js/chart.js            grafico SVG
js/weather.js          icone meteo e formattazione
sw.js                  service worker (funzionamento offline)
manifest.webmanifest   metadati PWA
icons/                 icone dell'app
server/config.py       configurazione (località, database, frequenze)
server/sources.py      download e normalizzazione delle fonti esterne
server/jobs.py         job di aggiornamento (lanciati da cron)
server/api.py          API JSON (e file statici in locale)
server/db.py           database SQLite
tests/                 test del server
deploy/                nginx, systemd, crontab
```

## Fonti dei dati

- Previsioni, ensemble e metadati dei modelli: [Open-Meteo](https://open-meteo.com/) (licenza CC BY 4.0).
- Medie del periodo 1991–2020: reanalisi ERA5-Land (Copernicus Climate Change Service), dall'archivio storico di Open-Meteo.
- ICON-2I © [ItaliaMeteo-ARPAE](https://www.arpae.it/); ICON-EU, ICON-EU-EPS e ICON-D2-EPS © [Deutscher Wetterdienst](https://www.dwd.de/).
- Misure: Osservatorio Meteorologico "E. Torricelli", [meteofaenza.it](https://www.meteofaenza.it/).

Nota tecnica sulla centralina: il suo file dati è un piccolo file JavaScript con le variabili delle misure. Lo legge il server, che ne estrae i valori senza eseguirlo; il browser non lo carica più.

## Privacy

L'app non ha login e non raccoglie dati personali: il server conserva solo i dati meteo (previsioni, misure della centralina, medie). Preferenze di visualizzazione, tema, modelli mostrati e intervalli monitorati restano solo nel `localStorage` del browser, insieme a una copia delle previsioni (al massimo di un giorno prima) per l'uso offline. Come ogni server web, nginx registra nei suoi log gli indirizzi IP delle richieste.
