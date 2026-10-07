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
| `index.html` | Shell della pagina: intestazione "Meteo Faenza" (titolo, dettagli località `#loc-sub`, pulsante aggiorna), stato (caricamento/errore), "adesso", prossimi giorni, grafico, tabella oraria |
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
- Tabella oraria su mobile (≤560 px): deve stare in 390 px senza scorrere. Per questo l'ora è mostrata come "07" (`.mm` nascosto), il simbolo % è nascosto e le righe alba/tramonto sono un'unica cella (`colspan` su tutte le colonne). Aggiungendo colonne, ricontrollare `scrollWidth` di `.table-wrap`.
- Oltre l'orizzonte di un modello i valori sono `null`: il rendering deve sempre gestire `null` (mostrare "—" o "oltre l'orizzonte del modello").
- Fuori dal dominio ICON-2I (bbox in `MODELS`) tutti i valori 2I sono `null`: viene mostrato un avviso.
- Gli orari dell'API sono già nell'ora locale della località (stringhe `YYYY-MM-DDTHH:00`): non convertirli con `Date` locale del browser; usare `parts()` e `localNowIso(utcOffset)` di `weather.js`.
- Gli istanti assoluti (ora di download `fetchedAt`, run dei modelli) vanno sempre mostrati nell'**ora locale della località**, mai in quella del dispositivo né in UTC: usare `localDateTime(ms, data.timezone, data.utcOffset)` di `weather.js`.
- Riga di aggiornamento: "prossimo alle …" = `fetchedAt + CACHE_TTL_MS` (30 min). Con l'app aperta il timer al minuto in fondo ad `app.js` riscarica davvero alla scadenza (oltre che al ritorno in primo piano/online). Per ogni modello "prossimo ~…" è una **stima**: `last_run_availability_time + update_interval_seconds` dai metadati (ICON-2I ogni 12 h, ICON-EU ogni 3 h); se l'orario è già passato si mostra "nuovo run in arrivo".
- Le differenze nel tooltip e nei giorni sono sempre calcolate come **2I − EU**.
- Box "Adesso": etichetta e valore sempre sulla stessa riga; con container query su `.now-card` (≥400 px) i quattro dati vanno in colonna a destra di icona e temperatura, altrimenti sotto (griglia 2×2, o 1 colonna su mobile).
- **Box Adesso con centralina**: riga "Misurato" (`renderObservation()`, box che occupa entrambe le colonne dei modelli) sopra la riga "Previsto". Nei box dei modelli "vs misurato" = temperatura prevista **interpolata al minuto della misura** (`modelTempAt()`) − temperatura misurata; mostrato solo se la misura ha meno di 30 min (`STATION_STALE_MS`), altrimenti la riga Misurato segnala "non aggiornato". La misura si riscarica ogni 5 min con l'app aperta (`STATION_REFRESH_MS`), al ritorno in primo piano e con il pulsante aggiorna; l'ultima è salvata in `meteo:station`.
- "Prossimi giorni" mostra solo oggi, domani e dopodomani (`DAILY_DAYS` in `app.js`); il grafico e il dettaglio orario usano invece tutto l'orizzonte scaricato (6 giorni).
- "Prossimi giorni" suddivide ogni giornata in 4 fasce da 6 ore (`SLOTS` in `app.js`: notte 0–6, mattina 6–12, pomeriggio 12–18, sera 18–24), calcolate dai dati **orari** (`slotSummary`): icona = codice WMO più severo, temperatura = media (min–max nel tooltip), pioggia = somma. Una fascia coperta per meno di metà delle ore mostra "—"; le fasce già trascorse di oggi sono attenuate. Layout della fascia gestito con container query sulla scheda `.dm` (in fondo a `style.css`): da 240 px icona grande con temperatura e pioggia impilate a destra (icona più grande da 340 px); sotto i 240 px (mobile) icona, temperatura e pioggia in colonna. Nei giorni coperti solo in parte da un modello (fine orizzonte) si mostrano solo le fasce, senza riepilogo giornaliero.
- Alba e tramonto (`daily.sunrise` / `daily.sunset`, mostrati sotto il nome del giorno) sono dati astronomici identici per i due modelli: `api.js` li salva una sola volta, fuori da `daily.models`. Le cache senza questi campi vengono riscaricate. Nel dettaglio orario una riga dedicata con l'orario esatto segue la riga dell'ora piena in cui cade l'evento. Icona condivisa: `sunEventIcon()` in `weather.js`; colori nei token `--dawn-*`, `--dusk-*`, `--sunset`.
- **Tragitti in bici** (righe sotto la concordanza in "Prossimi giorni"): elenco in `BIKE_COMMUTES` (`app.js`), ognuno con `label` e `windows` (ora locale). Attualmente:
  - Bike to work: 07:00–08:00, 12:20–14:00, 17:00–18:30;
  - Bike to school: 06:45–07:15, 13:30–15:00.
  - Layout: tutti i blocchi (tutti i tragitti, tutti i giorni) hanno la stessa larghezza, quella del più largo. Su desktop le etichette stanno nella colonna dei nomi dei giorni (`.day` area `"bike bike"`, `.bikes` con colonna `--label-w`) e i blocchi partono allineati ai box dei modelli. Gli orari sono sempre in formato HH:MM–HH:MM. `fitBikes()` misura i blocchi, calcola quante colonne stanno accanto all'etichetta (max = numero massimo di finestre) e imposta `--bike-chip-w` / `--bike-cols` su `#daily`; se non ne sta nessuna, l'etichetta va sopra (`bikes-stacked`). Va richiamata dopo ogni render di "Prossimi giorni" e al resize.
  Per aggiungere un tragitto basta una voce in `BIKE_COMMUTES`; l'ensemble è scaricato per 3 giorni, quindi copre "Prossimi giorni".
  - Pioggia e probabilità orarie di Open-Meteo si riferiscono all'ora **precedente** il timestamp: `windowHours()` mappa la finestra sulle ore API con peso di sovrapposizione (es. 12:20–14 → 13:00 × 40/60 + 14:00).
  - Verdetto (`bikeWindow()`): un modello "vede pioggia" se ≥ `BIKE_WET_MM` (0,2 mm) nel tragitto. Entrambi → Pioggia (mostra la media dei mm); uno solo → Incerto (mostra intervallo min–max); nessuno → Asciutto, oppure Rischio se la probabilità max ≥ `BIKE_RISK_POP` (40%). Volutamente niente media semplice per il verdetto: nasconderebbe il disaccordo.
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
  - Il motivo (criteri violati + aspetti concordi) va nel `title` dell'etichetta e, al clic/tocco, in un avviso (su touch il tooltip non esiste).

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
