# Meteo Faenza

Web app (PWA) che mette a confronto le previsioni di due modelli meteorologici per **Faenza** e le affianca alle misure reali della centralina cittadina:

- **ICON-2I**: modello ad alta risoluzione (2,2 km) di ItaliaMeteo-ARPAE, copre l'Italia per circa 3 giorni e mezzo;
- **ICON-EU**: modello europeo (7 km) del servizio meteorologico tedesco DWD, copre circa 5 giorni e mezzo;
- **Centralina**: Osservatorio Meteorologico "E. Torricelli" ([meteofaenza.it](https://www.meteofaenza.it/)).

È composta solo da file statici: nessun server, nessuna API key, nessun passaggio di build. Le previsioni vengono salvate nel browser e restano consultabili anche offline.

## Cosa mostra

- **Adesso**: l'ultima misura della centralina (temperatura con minima e massima del giorno, umidità, vento, pioggia di oggi, raffica massima). Viene aggiornata ai minuti :00, :10, :20, :30, :40, :50.
- **Prossimi giorni** (oggi, domani, dopodomani), con i due modelli affiancati:
  - riepilogo del giorno e suddivisione in quattro fasce (notte, mattina, pomeriggio, sera);
  - alba, tramonto e probabilità di pioggia;
  - un giudizio sulla **concordanza dei modelli** (concordi / lievi differenze / discordi), con il motivo;
  - **Bike to work** e **Bike to school**: per ogni tragitto in bici, se pioverà (Asciutto, Rischio, Incerto, Pioggia) e con quale probabilità.
- **Andamento orario**: grafico che sovrappone i due modelli per temperatura, precipitazioni, vento, nuvolosità, umidità e pressione.
- **Dettaglio orario** (chiuso di default): tabella ora per ora con entrambi i modelli e la probabilità di pioggia.

Tutti gli orari sono nell'ora locale di Faenza.

### Come leggere i tragitti in bici

Per ogni intervallo l'app controlla se ciascun modello prevede almeno 0,2 mm di pioggia, e qual è la probabilità calcolata sui 40 scenari dell'ensemble ICON-EU-EPS.

| Verdetto | Quando |
|---|---|
| ☂ Pioggia | entrambi i modelli vedono pioggia e probabilità ≥ 30%, oppure uno solo e ≥ 60%, oppure probabilità ≥ 80% |
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

Le impostazioni principali sono costanti in `js/app.js`:

| Cosa | Dove |
|---|---|
| Località (nome, coordinate, quota) | `LOCATION` |
| Tragitti in bici e relativi orari | `BIKE_COMMUTES` |
| Soglie del verdetto dei tragitti | `BIKE_WET_MM`, `BIKE_POP_BOTH`, `BIKE_POP_ONE`, `BIKE_POP_ANY`, `BIKE_POP_DRY` |
| Soglie della concordanza dei modelli | `AGREE` |
| Giorni mostrati in "Prossimi giorni" | `DAILY_DAYS` |

La centralina è specifica di Faenza: cambiando località va sostituita o rimossa (`js/station.js`).

## Struttura

```
index.html             pagina
css/style.css          stile (tema chiaro e scuro automatico)
js/app.js              logica e rendering
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
- ICON-2I © [ItaliaMeteo-ARPAE](https://www.arpae.it/), ICON-EU © [Deutscher Wetterdienst](https://www.dwd.de/).
- Misure: Osservatorio Meteorologico "E. Torricelli", [meteofaenza.it](https://www.meteofaenza.it/).

Nota tecnica sulla centralina: il suo file dati non consente la lettura da altri siti (CORS), quindi l'app lo carica come script. In questo modo il contenuto del file viene eseguito nella pagina; oggi contiene solo valori, ma dipende da un sito esterno.

## Privacy

L'app non ha un backend e non raccoglie dati. Previsioni, ultima misura e preferenze di visualizzazione sono salvate solo nel `localStorage` del browser.
