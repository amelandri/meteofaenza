# CLAUDE.md — Meteo a confronto

PWA statica che confronta le previsioni dei modelli **ICON-2I** (ItaliaMeteo-ARPAE, 2,2 km, solo area italiana, ~87 h) e **ICON-EU** (DWD, 7 km, Europa, ~135 h) per una **località fissa: Faenza** (costante `LOCATION` in `js/app.js`; non c'è ricerca né geolocalizzazione).

## Vincoli di progetto

- **Nessuna logica lato server.** Solo file statici: HTML, CSS, JavaScript (ES modules) e icone. Nessun backend proprio, nessuna API key.
- **Nessun build step e nessuna dipendenza npm** a runtime. Il codice gira così com'è nel browser.
- **Persistenza solo nel browser** tramite `localStorage` (vedi `js/storage.js`). Ogni accesso è in `try/catch`: l'app deve funzionare anche se lo storage è bloccato.
- **Interfaccia in italiano**, commenti nel codice in italiano.
- Percorsi **relativi** (`./`, `js/…`) così l'app funziona anche in una sottocartella (es. GitHub Pages).

## Avvio in locale

```bash
python3 -m http.server 8000
# poi aprire http://localhost:8000
```

Il service worker richiede `http://localhost` o HTTPS (non funziona da `file://`).

## Struttura

| File | Ruolo |
|---|---|
| `index.html` | Shell della pagina: intestazione "Meteo Faenza" (titolo, dettagli località `#loc-sub`, pulsante aggiorna), stato (caricamento/errore), "adesso" (centralina), prossimi giorni, grafico, tabella oraria, piè di pagina (info di aggiornamento `#updated` + crediti) |
| `css/style.css` | Stile; token colore in `:root`, tema scuro via `prefers-color-scheme`. Colori modelli: `--i2i` (verde acqua), `--eu` (arancio) |
| `js/app.js` | Località fissa (`LOCATION`), stato, rendering di tutte le sezioni, registrazione SW |
| `js/api.js` | Chiamate HTTP: previsioni, ensemble, metadati del run. Definisce `MODELS`, `HOURLY_VARS`, `DAILY_VARS` |
| `js/storage.js` | `localStorage`: impostazioni, cache previsioni (TTL 30 min), pulizia dei dati delle versioni precedenti |
| `js/chart.js` | Grafico SVG senza librerie (linee/barre, fasce giornaliere, linea "adesso", tooltip) |
| `js/station.js` | Misure reali della centralina di Faenza (meteofaenza.it), caricate come `<script>` |
| `js/weather.js` | Codici WMO → descrizione italiana e icone SVG inline; formattazione numeri/date |
| `sw.js` | Service worker: precache della shell, stale-while-revalidate per i file della stessa origine |
| `manifest.webmanifest`, `icons/` | Metadati PWA e icone (PNG generate da `icons/icon.svg`) |

## Fonti dati (tutte con CORS aperto, senza chiave)

- Previsioni: `https://api.open-meteo.com/v1/forecast?models=italia_meteo_arpae_icon_2i,icon_eu&timezone=auto…`
  Le variabili arrivano con suffisso del modello, es. `temperature_2m_icon_eu`; `api.js` le normalizza in `hourly.models.{i2i,eu}.{variabile}`.
- Metadati run: `https://api.open-meteo.com/data/{metaId}/static/meta.json` — attenzione: per ICON-EU il dataset è `dwd_icon_eu`, non `icon_eu` (campo `metaId` in `MODELS`).
- Ensemble (probabilità sui tragitti in bici): `https://ensemble-api.open-meteo.com/v1/ensemble?models=icon_eu_eps…`
- Centralina (dati misurati): `https://www.meteofaenza.it/dati/today/data.js`, Osservatorio "E. Torricelli", aggiornata ~ogni minuto. **Eccezione al CORS**: il file non ha intestazioni CORS, quindi `fetch()` fallisce; `station.js` lo carica con un tag `<script>` (con `?t=` anti-cache) e legge le variabili globali stringa (`temperature`, `humidity`, `pressure`, `windSpeed` km/h, `windDirection` °, `rainfall` mm oggi, `dewPoint`, `temperatureMin/Max` + orari, `windSpeedMax` + orario, `currentTimeMillis` = istante della misura). Il codice del file viene eseguito nella pagina: se il formato cambia, `parse()` fallisce e resta l'ultima misura salvata.
- Attribuzione obbligatoria (già nel footer): Open-Meteo CC BY 4.0, ItaliaMeteo-ARPAE, DWD.

## Note di dominio

- Non mettere nei box dei modelli variabili assenti in uno dei due, altrimenti il confronto è sbilanciato. Verificare la disponibilità con una chiamata di prova prima di aggiungerne.
- **Dati comuni** (`COMMON_HOURLY` / `COMMON_DAILY` in `api.js`): salvati direttamente in `hourly.<var>` / `daily.<var>`, fuori da `models`, e mostrati fuori dai box dei modelli.
  - Probabilità di precipitazioni (`precipitation_probability`, `precipitation_probability_max`): Open-Meteo la ricava da modelli ensemble (~25 km) e la restituisce solo con suffisso `icon_eu` (per ICON-2I è sempre null). Va presentata come stima generale, non come dato ICON-EU: colonna del giorno (`rainChance()`) e colonna "Prob." del dettaglio orario (`popCell()`).
- "Dettaglio orario" è collassabile e **chiuso di default** (`settings.hourlyOpen`, ricordato nel localStorage). Da chiuso la tabella non viene costruita: `renderHourlyTable()` la genera solo quando la sezione è aperta.
- Tabella oraria su mobile (≤560 px): deve stare in 390 px senza scorrere. Per questo l'ora è mostrata come "07" (`.mm` nascosto) e il simbolo % è nascosto. Aggiungendo colonne, ricontrollare `scrollWidth` di `.table-wrap`.
- Oltre l'orizzonte di un modello i valori sono `null`: il rendering deve sempre gestire `null` (mostrare "—" o "oltre l'orizzonte del modello").
- Fuori dal dominio ICON-2I (bbox in `MODELS`) tutti i valori 2I sono `null`: viene mostrato un avviso.
- Gli orari dell'API sono già nell'ora locale della località (stringhe `YYYY-MM-DDTHH:00`): non convertirli con `Date` locale del browser; usare `parts()` e `localNowIso(utcOffset)` di `weather.js`.
- Gli istanti assoluti (ora di download `fetchedAt`, run dei modelli) vanno sempre mostrati nell'**ora locale della località**, mai in quella del dispositivo né in UTC: usare `localDateTime(ms, data.timezone, data.utcOffset)` di `weather.js`.
- Riga di aggiornamento (`#updated`, **nel piè di pagina**, sopra i crediti): "prossimo alle …" = `fetchedAt + CACHE_TTL_MS` (30 min). Con l'app aperta il timer al minuto in fondo ad `app.js` riscarica davvero alla scadenza (oltre che al ritorno in primo piano/online). Per ogni modello "prossimo ~…" è una **stima**: `last_run_availability_time + update_interval_seconds` dai metadati (ICON-2I ogni 12 h, ICON-EU ogni 3 h); se l'orario è già passato si mostra "nuovo run in arrivo".
- Le differenze nel tooltip e nei giorni sono sempre calcolate come **2I − EU**.
- **Box Adesso = solo centralina**: nessuna previsione per l'ora corrente, solo la riga "Misurato" (`renderObservation()`, box che occupa entrambe le colonne dei modelli). Se non c'è alcuna misura (centralina irraggiungibile e niente in cache) compare "Dati della centralina non disponibili". Misura più vecchia di 30 min (`STATION_STALE_MS`) → "non aggiornato". La misura si aggiorna **solo ai minuti :00, :10, :20, :30, :40, :50** (+15 s, `STATION_SLOT_MS` / `STATION_SLOT_DELAY_MS`, timer `scheduleStation()`); con l'app in background la lettura è saltata. All'avvio, al ritorno in primo piano e al ritorno online si riscarica solo se è stato perso un orario programmato (`stationMissedSlot()`). Il pulsante aggiorna la riscarica sempre. Sotto "Misurato" è indicata la prossima lettura. L'ultima misura è salvata in `meteo:station`.
- "Prossimi giorni" mostra solo oggi, domani e dopodomani (`DAILY_DAYS` in `app.js`); il grafico e il dettaglio orario usano invece tutto l'orizzonte scaricato (6 giorni).
- "Prossimi giorni" suddivide ogni giornata in 4 fasce da 6 ore (`SLOTS` in `app.js`: notte 0–6, mattina 6–12, pomeriggio 12–18, sera 18–24), calcolate dai dati **orari** (`slotSummary`): icona = `slotCode()`: se c'è precipitazione o temporale (codice ≥ 51) anche in una sola ora vince il più severo, altrimenti il tempo **prevalente** tra i gruppi sereno (0–1) / nuvoloso (2–3) / nebbia (45–48), a parità il peggiore (non più "il più severo" sempre: 3 ore di nebbia all'alba coprivano una mattina di sole); per la fascia in corso di oggi l'icona considera solo le ore non ancora trascorse. Temperatura = media (min–max nel tooltip), pioggia = somma (su tutte le ore della fascia). Una fascia coperta per meno di metà delle ore mostra "—"; le fasce già trascorse di oggi sono attenuate. Layout della fascia gestito con container query sulla scheda `.dm` (in fondo a `style.css`): da 240 px icona grande con temperatura e pioggia impilate a destra (icona più grande da 340 px); sotto i 240 px (mobile) icona, temperatura e pioggia in colonna. Su mobile (≤560 px) la riga di intestazione delle fasce (`.slots-legend`) è nascosta: le ore di confine 6/12/18 (`slotTicks()`, `.slot-tick`) compaiono dentro ogni box sulla linea tratteggiata, centrate sopra i separatori; anche la riga di intestazione (`.slots-head`) è nascosta. **Fonte della previsione (desktop e mobile)**: legenda nel titolo della card (`.sources`: pallino colorato + nome in grigio, allineata a destra, ordine = colonne) e pallino di 6 px del colore del modello in alto a destra di ogni box (`.dm::after`); niente nomi dei modelli sopra le colonne. Su desktop il box ha 20 px di margine destro per il pallino (e `.slots-legend` lo stesso, per restare allineata alle fasce). Nei giorni coperti solo in parte da un modello (fine orizzonte) si mostrano solo le fasce, senza riepilogo giornaliero.
- Alba e tramonto (`daily.sunrise` / `daily.sunset`, mostrati sotto il nome del giorno) sono dati astronomici identici per i due modelli: `api.js` li salva una sola volta, fuori da `daily.models`. Le cache senza questi campi vengono riscaricate. Su mobile (≤560 px) alba, tramonto, durata della luce (forma breve "11h 25m", `.daylight .short`) e probabilità (senza la parola "pioggia", `.pop-word` nascosto) stanno su una sola riga (`.sun` nowrap); se non c'è spazio accanto al nome del giorno la riga va a capo intera. Icona condivisa: `sunEventIcon()` in `weather.js`; colori nei token `--dawn-*`, `--dusk-*`, `--sunset`.
- **Tragitti in bici** (righe sotto la concordanza in "Prossimi giorni"): elenco in `BIKE_COMMUTES` (`app.js`), ognuno con `label` e `windows` (ora locale). Attualmente:
  - Bike to work: 07:00–08:00, 12:20–14:00, 17:00–18:30;
  - Bike to school: 06:45–07:15, 13:30–15:00.
  - Layout: tutti i blocchi (tutti i tragitti, tutti i giorni) hanno la stessa larghezza, quella del più largo (`fitBikes()` → `--bike-chip-w` su `#daily`, da richiamare dopo ogni render di "Prossimi giorni" e al resize). Su desktop i tragitti stanno **sulla stessa riga, allineati alle colonne del giorno** (`.bikes` grid: colonna `--label-w` + 8 px, poi due colonne uguali con gap 8 px = box ICON-2I / ICON-EU): etichetta di Bike to work nella colonna dei nomi e blocchi sotto ICON-2I, Bike to school (etichetta + blocchi) dal bordo di ICON-EU. Se i blocchi non entrano nelle colonne, o con il giorno su una colonna (≤720 px), `fitBikes()` aggiunge `.bikes-flow`: tragitti uno dopo l'altro, a capo se serve. Su mobile (≤560 px) un tragitto per riga, etichetta sopra e blocchi a colonne uguali (`--bike-max`). Gli orari sono sempre in formato HH:MM–HH:MM.
  - Blocchi = `<button class="bike-chip" data-tip>`: icona di stato (`BIKE_STATUS`: sole = Asciutto, nuvola = Rischio, nuvola con goccia = Incerto, ombrello = Pioggia), al tocco il dettaglio (mm per modello, probabilità) va nello stesso avviso dell'etichetta di concordanza. Blocco compatto ovunque (desktop e mobile): orario sopra, icona + % sotto; testo dello stato, mm e "solo EU" nascosti (sono nel tooltip/avviso). Su desktop i blocchi hanno la larghezza del più largo (`fitBikes()`) e partono allineati ai box dei modelli; su mobile (≤560 px) ogni tragitto è una sola riga a colonne uguali (`--bike-max`).
  Per aggiungere un tragitto basta una voce in `BIKE_COMMUTES`; l'ensemble è scaricato per 3 giorni, quindi copre "Prossimi giorni".
  - Pioggia e probabilità orarie di Open-Meteo si riferiscono all'ora **precedente** il timestamp: `windowHours()` mappa la finestra sulle ore API con peso di sovrapposizione (es. 12:20–14 → 13:00 × 40/60 + 14:00).
  - Verdetto (`bikeVerdict()`): combina i modelli con la probabilità dell'ensemble. Un modello "vede pioggia" se ≥ `BIKE_WET_MM` (0,2 mm) nel tragitto. **Pioggia** = entrambi + prob ≥ 30% (`BIKE_POP_BOTH`), oppure uno solo + prob ≥ 60% (`BIKE_POP_ONE`), oppure prob ≥ 80% (`BIKE_POP_ANY`); **Asciutto** = nessuno + prob < 20% (`BIKE_POP_DRY`); **Rischio** = nessun modello ma prob ≥ 20%; **Incerto** = tutti gli altri casi. Senza probabilità si giudica solo sui modelli. Il motivo ("Perché: …") è nel dettaglio del blocco. mm mostrati: media se tutti i modelli vedono pioggia, altrimenti intervallo min–max. Niente media semplice dei mm per il verdetto: nasconderebbe il disaccordo. (Introdotto dopo il caso di venerdì 9/10: "Pioggia" al 38% e "Incerto" al 70% con la vecchia regola basata solo sui modelli.)
  - Se un modello non copre la finestra si usa l'altro ("solo EU"); finestre già trascorse di oggi attenuate.
  - **Probabilità nel tragitto** (`windowRainChance()`): quota dei 40 scenari ICON-EU-EPS (Ensemble API, `fetchEnsemble()` in `api.js`, salvati in `data.ensemble`) con almeno 0,1 mm *nel tragitto* (ore parziali pesate). **Non** usare la massima delle probabilità orarie: sottostima i tragitti su più ore, perché scenari diversi piovono in ore diverse (verificato: es. 45% vs 50% reale). Se l'ensemble manca si ripiega sulla massima oraria, mostrata con "~" e segnalata nel tooltip.
  - Ensemble API: con **un solo modello** richiesto le chiavi non hanno suffisso (`precipitation`, `precipitation_member01`…); con più modelli sì (`…_icon_eu_eps`). La regex in `fetchEnsemble()` accetta entrambe.
  - La `precipitation_probability` oraria di Open-Meteo è "quota di membri ICON-EPS/ICON-EU-EPS con > 0,1 mm/h" ma non è riproducibile esattamente dai membri dell'Ensemble API (scarto medio ~3 punti, run/elaborazione diversi): nella colonna del giorno e nella tabella oraria resta quella dell'API.
- **Concordanza dei modelli** (`agreement()` in `app.js`, soglie in `AGREE`): somma di punti di disaccordo, 0 → concordi, 1 → lievi differenze, ≥2 → discordi.
  - Temperature: differenza maggiore tra massime e minime ≥ 1,5° → 1 punto, ≥ 3° → 2.
  - Pioggia per fasce di 6 h (solo dove entrambi hanno dati): disaccordo se un modello ≥ 1 mm e l'altro < 0,3 mm (valori intermedi non giudicati); 1 fascia → 1 punto, ≥ 2 → 2.
  - Quantità (solo se piove per entrambi e le fasce concordano): uno ≥ doppio dell'altro e scarto ≥ 3 mm → 1 punto.
  - Temporale (codice WMO ≥ 95) in una fascia per un solo modello → 1 punto.
  - Raffiche: scarto ≥ 15 km/h con almeno uno ≥ 30 km/h → 1 punto.
  - Il motivo (criteri violati + aspetti concordi + differenze "Δ max · Δ pioggia (2I − EU)") va nel `title` dell'etichetta e, al clic/tocco, in un avviso (su touch il tooltip non esiste). Le differenze Δ non sono mostrate accanto all'etichetta (né su desktop né su mobile): sono solo nel tooltip/avviso.
  - Avviso (`toast()` / `hideToast()`): si chiude con un secondo tap sulla stessa etichetta, con un tap sull'avviso o in qualsiasi altro punto della pagina, oppure da solo dopo 9 s; un tap su un'altra etichetta lo sostituisce. `width: max-content` serve perché con `left: 50%` la larghezza disponibile sarebbe metà schermo.

## Chiavi localStorage

Prefisso `meteo:` — `settings`, `cacheIndex`, `fc:<lat>,<lon>` (lat/lon con 3 decimali). All'avvio `removeLegacyKeys()` elimina `favorites`, `lastLocation` e le previsioni di località diverse da Faenza, rimaste dalle versioni con località selezionabile.
Se cambia la forma dei dati salvati, gestire o scartare i dati vecchi in lettura.

## Convenzioni di sviluppo

- **Dopo ogni modifica a file della shell, incrementare `VERSION` in `sw.js`**, altrimenti gli utenti continuano a vedere la versione in cache. Se si aggiunge un file, inserirlo anche nell'array `SHELL`.
- Prima di inserire testo proveniente da API nell'HTML usare `esc()` (`weather.js`).
- Layout mobile-first: verificare a 390 px di larghezza che non ci sia scroll orizzontale della pagina.
- Le sezioni "Adesso" e "Prossimi giorni" condividono la stessa griglia (`.day` → `.day-name` + `.day-models` a due colonne, larghezza etichetta `--label-w`): le colonne ICON-2I / ICON-EU devono restare allineate verticalmente a ogni larghezza. Non dare a una sola delle due sezioni padding o colonne diverse.
- Nuove variabili del grafico: aggiungerle a `VARIABLES` in `app.js` (e a `HOURLY_VARS` in `api.js` se non già scaricate).
- Rigenerare le icone PNG (Pillow) se cambia `icons/icon.svg`: 192, 512, maskable 512 (senza angoli arrotondati), apple-touch 180.

## Verifica manuale

1. All'apertura compaiono subito le previsioni di Faenza: entrambi i modelli visibili, ICON-2I si interrompe dopo ~3,5 giorni.
2. Ricaricare offline (DevTools → Network → Offline): la pagina e le previsioni salvate devono comparire con il banner offline.
3. Offline senza dati salvati (localStorage vuoto): messaggio di stato con pulsante "Riprova".
