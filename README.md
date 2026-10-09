# Meteo Faenza

Web app (PWA) che mette a confronto le previsioni di due modelli meteorologici per **Faenza** e le affianca alle misure reali della centralina cittadina:

- **ICON-2I**: modello ad alta risoluzione (2,2 km) di ItaliaMeteo-ARPAE, copre l'Italia per circa 3 giorni e mezzo;
- **ICON-EU**: modello europeo (7 km) del servizio meteorologico tedesco DWD, copre circa 5 giorni e mezzo;
- **Centralina**: Osservatorio Meteorologico "E. Torricelli" ([meteofaenza.it](https://www.meteofaenza.it/)).

È composta solo da file statici: nessun server, nessuna API key, nessun passaggio di build. Le previsioni vengono salvate nel browser e restano consultabili anche offline (fino a un giorno dal download).

## Cosa mostra

- **Adesso**: l'ultima misura della centralina (temperatura con minima e massima del giorno, umidità, vento, pioggia di oggi, raffica massima). Viene aggiornata ai minuti :00, :10, :20, :30, :40, :50. Se i millimetri di oggi aumentano tra una lettura e l'altra compare "sta piovendo".
- **Oggi, Domani, Dopodomani**: una scheda per giorno, con i due modelli a confronto:
  - riepilogo del giorno e suddivisione in quattro fasce (notte, mattina, pomeriggio, sera);
  - alba e tramonto; per ogni fascia anche la probabilità di pioggia;
  - un giudizio sulla **concordanza dei modelli** (concordi / lievi differenze / discordi), con il motivo;
  - **Bike**: per ogni intervallo del tragitto in bici (nome e fino a 3 "intervalli monitorati" configurabili nella pagina Impostazioni; predefiniti 06:45–08:00, 12:30–15:00, 17:00–18:30), se pioverà (Asciutto, Rischio, Incerto, Pioggia) e con quale probabilità.
- **Andamento orario**: grafico che sovrappone i due modelli per precipitazioni (con la probabilità di pioggia ora per ora), temperatura, vento, nuvolosità, umidità e pressione. Nella temperatura due linee tratteggiate mostrano le previsioni corrette con la misura della centralina per le ore successive.
- **Dettaglio orario** (chiuso di default): tabella ora per ora con entrambi i modelli e la probabilità di pioggia.

Tutti gli orari sono nell'ora locale di Faenza.

La pagina **Impostazioni** (icona a ingranaggio) permette di scegliere il tema (automatico, chiaro o scuro) e gli intervalli monitorati. La pagina **Come funziona** (icona "i") spiega modelli, ensemble, calcolo della probabilità e regole dei verdetti.

Con l'app aperta le previsioni vengono riscaricate ogni 30 minuti e circa 10 minuti dopo l'uscita prevista di un nuovo run dei modelli.

### Come leggere i tragitti in bici

Per ogni intervallo l'app controlla se ciascun modello prevede almeno 0,2 mm di pioggia, e qual è la probabilità: la quota di scenari con almeno 0,2 mm nei due ensemble del DWD, ICON-EU-EPS (40 scenari, circa 5 giorni) e ICON-D2-EPS (20 scenari a 2,2 km, circa 2 giorni). Dove ci sono entrambi la probabilità è la media delle due.

| Verdetto | Quando |
|---|---|
| ☂ Pioggia | entrambi i modelli vedono pioggia e probabilità ≥ 30%, oppure uno solo e ≥ 60%, oppure probabilità ≥ 80%; oppure sta piovendo adesso secondo la centralina e il tragitto è in corso o inizia entro 30 minuti |
| ☀ Asciutto | nessun modello vede pioggia e probabilità < 20% |
| ☁ Rischio | nessun modello vede pioggia, ma probabilità ≥ 20% |
| ☁💧 Incerto | tutti gli altri casi |

Toccando un tragitto (o passandoci sopra con il mouse) si vede il dettaglio: millimetri per modello, probabilità e motivo del verdetto.

## Avvio in locale

Serve un qualsiasi server HTTP statico, per esempio:

```bash
python3 -m http.server 8000
```

poi aprire <http://localhost:8000>. Aprendo direttamente `index.html` dal disco (`file://`) il service worker non funziona e l'app non è installabile.

## Pubblicazione

Basta copiare la cartella su un hosting statico con HTTPS (GitHub Pages, Netlify, un qualsiasi web server). I percorsi sono relativi, quindi l'app funziona anche in una sottocartella.

Dopo ogni modifica ai file dell'app va incrementato `VERSION` in `sw.js`: altrimenti chi l'ha già aperta continua a vedere la versione salvata nel browser.

## Installazione su telefono

L'app è una PWA: da Chrome o Edge si installa con l'icona nella barra degli indirizzi, da Safari su iPhone con *Condividi → Aggiungi alla schermata Home*.

## Personalizzazione

Tema e intervalli monitorati si scelgono dalla pagina Impostazioni. Il resto è nelle costanti del codice:

| Cosa | Dove |
|---|---|
| Località (nome, coordinate, quota) | `LOCATION` in `js/app.js` |
| Intervalli monitorati predefiniti | `DEFAULT_WATCH` in `js/storage.js` |
| Soglie del verdetto dei tragitti | `BIKE_WET_MM`, `BIKE_POP_BOTH`, `BIKE_POP_ONE`, `BIKE_POP_ANY`, `BIKE_POP_DRY` in `js/app.js` |
| Pioggia in corso dalla centralina | `RAIN_NOW_*` in `js/app.js` |
| Correzione della temperatura con la centralina | `TEMP_FIX_*` in `js/app.js` |
| Soglie della concordanza dei modelli | `AGREE` in `js/app.js` |
| Giorni mostrati in "Prossimi giorni" | `DAILY_DAYS` in `js/app.js` |
| Ensemble usati per la probabilità | `ENSEMBLE_MODELS` in `js/api.js` |
| Frequenza dei download | `CACHE_TTL_MS`, `RETRY_TTL_MS`, `RUN_DELAY_MS` in `js/storage.js` |

Se si cambiano soglie o regole, va aggiornata anche la pagina `info.html`, che le riporta in chiaro.

La centralina è specifica di Faenza: cambiando località va sostituita o rimossa (`js/station.js`).

## Struttura

```
index.html             pagina principale
info.html              pagina "Come funziona" (modelli, ensemble, calcolo della probabilità)
settings.html          pagina Impostazioni (tema, intervalli monitorati)
css/style.css          stile (tema chiaro e scuro)
js/theme.js            applica il tema scelto prima che la pagina compaia
js/app.js              logica e rendering
js/settings.js         pagina Impostazioni
js/api.js              previsioni, ensemble e metadati dei modelli (Open-Meteo)
js/station.js          misure della centralina
js/storage.js          salvataggio nel browser (localStorage)
js/chart.js            grafico SVG
js/weather.js          icone meteo e formattazione
sw.js                  service worker (funzionamento offline)
manifest.webmanifest   metadati PWA
icons/                 icone dell'app
```

## Fonti dei dati

- Previsioni, ensemble e metadati dei modelli: [Open-Meteo](https://open-meteo.com/) (licenza CC BY 4.0).
- ICON-2I © [ItaliaMeteo-ARPAE](https://www.arpae.it/); ICON-EU, ICON-EU-EPS e ICON-D2-EPS © [Deutscher Wetterdienst](https://www.dwd.de/).
- Misure: Osservatorio Meteorologico "E. Torricelli", [meteofaenza.it](https://www.meteofaenza.it/).

Nota tecnica sulla centralina: il suo file dati non consente la lettura da altri siti (CORS), quindi l'app lo carica come script. In questo modo il contenuto del file viene eseguito nella pagina; oggi contiene solo valori, ma dipende da un sito esterno.

## Privacy

L'app non ha un backend e non raccoglie dati. Previsioni (al massimo di un giorno prima), ultime letture della centralina, preferenze di visualizzazione, tema e intervalli monitorati sono salvati solo nel `localStorage` del browser.
