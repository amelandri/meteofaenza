# Meteo Faenza

Web app (PWA) che mette a confronto le previsioni di due modelli meteorologici per **Faenza** e le affianca alle misure reali della centralina cittadina:

- **ICON-2I**: modello ad alta risoluzione (2,2 km) di ItaliaMeteo-ARPAE, copre l'Italia per circa 3 giorni e mezzo;
- **ICON-EU**: modello europeo (7 km) del servizio meteorologico tedesco DWD, copre circa 5 giorni e mezzo;
- **Centralina**: Osservatorio Meteorologico "E. Torricelli" ([meteofaenza.it](https://www.meteofaenza.it/)). L'app è un progetto indipendente, non collegato all'Osservatorio.

È composta da un **frontend statico** (HTML, CSS e JavaScript senza passaggio di build né dipendenze npm) e da un **piccolo server in Python** (libreria standard; numpy e Pillow solo per il radar) con un database **SQLite**. Il server scarica le fonti esterne a intervalli regolari, via cron, e le serve al frontend come API JSON: le fonti vengono interrogate una volta per tutti gli utenti e mai dal browser. Non serve alcuna API key. L'app richiede un **accesso con nome utente e password**: gli utenti si creano solo sul server, con uno script (vedi [Accesso](#accesso)). Le preferenze sono salvate sul server per utente, quindi valgono su tutti i dispositivi. Il browser tiene solo una copia delle preferenze e delle previsioni per l'uso offline (fino a un giorno dal download), cancellata quando si esce.

La località è fissa (costante `LOCATION` in `js/app.js`, `LAT` / `LON` in `server/config.py`): non c'è ricerca né geolocalizzazione.

## Cosa mostra

Il menu in alto è uguale in tutte le pagine (Previsioni, Verifica, Impostazioni, Come funziona) ed evidenzia la pagina attuale; su schermi da 900 px in su ogni voce ha anche l'etichetta.

### Previsioni (pagina principale)

- **Centralina**: l'ultima misura (temperatura con minima e massima del giorno e scarto dalla media del periodo, umidità, vento, pioggia di oggi, raffica massima, pioggia del mese e dell'anno, ultimo giorno di pioggia). Si aggiorna ai minuti :00, :10, :20, :30, :40, :50; i valori del giorno contano da mezzanotte (la centralina li azzera all'01:00 con l'ora legale: il server li ricalcola). Se i millimetri aumentano tra una lettura e l'altra compare "Sta piovendo". In fondo la riga **Radar**: pioggia su Faenza, in arrivo (con l'orario stimato), la più vicina entro 50 km o nessuna. L'icona "i" accanto al titolo spiega da dove vengono le misure.
- **Previsioni**: un'unica scheda con oggi, domani e dopodomani, i due modelli a confronto:
  - massima e minima con lo scarto dalla media del periodo, e quattro fasce di 6 ore (notte, mattina, pomeriggio, sera) con icona, temperatura e pioggia;
  - sotto i due modelli, per ogni fascia il **verdetto** (Asciutto, Rischio, Incerto, Pioggia, con gli stessi colori e le stesse regole delle ore) e la probabilità di pioggia (calcolata dagli ensemble); al tocco lo stesso dettaglio delle ore, con la sezione "Da sapere" se gli ensemble non sono d'accordo tra loro, se ce n'è uno solo o se la fascia è lontana;
  - alba e tramonto (oggi sulla linea dell'intera giornata, con sole o luna all'ora attuale);
  - un giudizio sulla **concordanza dei modelli** (concordi / lievi differenze / discordi), con il motivo;
  - le **allerte** della Regione per la zona di Faenza (B1, Allerta Meteo Emilia-Romagna): accanto a "Oggi" o "Domani" una pillola gialla, arancione o rossa con sotto i fenomeni in allerta; al tocco il colore di ogni fenomeno, la descrizione del bollettino e il PDF. Senza allerta non compare nulla.
- **Andamento orario**: grafico che sovrappone i due modelli per precipitazioni, temperatura, vento, nuvolosità, umidità e pressione, dall'ora attuale, per 24 ore, 72 ore o tutto l'orizzonte. Nelle precipitazioni:
  - barre dei mm di ciascun modello;
  - area azzurra con la **probabilità** di pioggia ora per ora (solo ensemble);
  - sotto il grafico, la **striscia del verdetto** ora per ora (Asciutto, Rischio, Incerto, Pioggia), vedi sotto.

  Nella temperatura due linee tratteggiate mostrano le previsioni corrette con la misura della centralina per le ore successive, e due linee punteggiate massima e minima medie del periodo. Nella nuvolosità le linee tratteggiate sono le previsioni corrette con la nuvolosità osservata (vedi sotto).

  **Nuvolosità osservata**: di giorno dalla radiazione solare della centralina, di notte dai bollettini METAR degli aeroporti di Forlì e Bologna (solo nubi basse). Non si mostra da sola: corregge, solo per oggi e per qualche ora, la nuvolosità prevista, quindi le icone delle fasce senza pioggia e il grafico della nuvolosità.
- **Radar** (chiuso di default): animazione del radar della Protezione Civile nell'ultima ora più la stima dei prossimi 60 minuti, su una cartina di 60 km attorno a Faenza; accanto, la stima su Faenza per i prossimi 90 minuti: una casella ogni 10 minuti colorata per intensità (a righe se la pioggia è solo possibile), divisa in tre tratti "affidabile" (prima mezz'ora), "indicativa" (30–60 minuti) e "orientativa" (oltre un'ora), perché più il momento è lontano meno la stima è sicura.
- **Fiumi** (chiuso di default; l'intestazione mostra comunque il livello a Faenza): livelli di Lamone (Marradi, Strada Casale, Sarna, Faenza) e Marzeno (Modigliana, Rivalta), con tendenza, soglie di allerta e grafico delle ultime 48 ore.
- **Dettaglio orario** (chiuso di default): tabella ora per ora con entrambi i modelli e la probabilità di pioggia; la cella dell'ora ha il colore del verdetto (come la striscia del grafico) e al tocco ne mostra il dettaglio.

Concordanza, probabilità delle fasce, caselle della striscia, ore del dettaglio orario e icona della centralina aprono un **dettaglio**: con il mouse un riquadro accanto all'elemento (al clic), al tocco un avviso in basso. Al tocco, con l'avviso aperto, il primo tocco fuori lo chiude soltanto e non attiva link o pulsanti sotto.

### Verifica

Per i giorni passati, pioggia e temperature previste la sera prima alle 23 (o due giorni prima) confrontate con quelle misurate dalla centralina: per ogni fascia e per il giorno intero, un esito per ogni modello (anche ICON-D2 e AROME) — corretta, falso allarme, pioggia non prevista, quantità molto diversa. In cima, affiancati su schermi larghi, il riepilogo per modello sul periodo scelto (7, 30, 60 o 90 giorni: fasce previste correttamente, falsi allarmi, errori medi su pioggia e temperature) e l'affidabilità della probabilità (indicatore a lancetta, numeri chiave, punteggio di Brier nei dettagli) con sotto la legenda degli esiti; poi "Giorno per giorno", due giorni per riga dal più recente, limitato agli ultimi 14 giorni (il riepilogo comprende tutto il periodo).

### Impostazioni

Tema (automatico, chiaro o scuro), previsioni mostrate (entrambi i modelli, solo ICON-2I o solo ICON-EU; la probabilità di pioggia resta sempre visibile), come si apre il grafico, sezioni aperte o chiuse all'avvio e scelte iniziali della Verifica. Le scelte si salvano subito sul server con il proprio utente (anche quelle fatte direttamente sul grafico o nella Verifica) e valgono su ogni dispositivo. La pagina sta in uno schermo: gruppi con una riga per preferenza (pulsanti affiancati per le scelte brevi, menu a tendina per il dato del grafico e la previsione giudicata, interruttori per le sezioni), con lo stesso aspetto delle previsioni giornaliere, in due colonne su schermi larghi. In alto il gruppo **Account** mostra l'utente collegato e il pulsante **Esci**.

### Accesso

Senza login il server non dà nessun dato: la pagina `login.html` chiede nome utente e password e poi riporta alla pagina da cui si era arrivati. Le pagine HTML, gli script e lo stile restano scaricabili senza accesso (il codice è pubblico), ma senza dati; la pagina Come funziona, che non usa dati, resta leggibile. Nelle Impostazioni la card **Account** mostra l'utente collegato e il pulsante **Esci**, che cancella anche le copie delle previsioni salvate nel browser, e permette di **cambiare la password**: serve quella attuale (i tentativi sbagliati contano come quelli del login), la nuova ha almeno 8 caratteri; le altre sessioni si chiudono, il browser da cui la si cambia resta collegato e i token personali restano validi.

- **Password**: nel database c'è solo il loro hash scrypt con sale casuale, non reversibile (PBKDF2-SHA256 se il Python del server non ha scrypt). La verifica confronta in tempo costante e, per un utente inesistente, impiega lo stesso tempo.
- **Sessioni**: cookie `meteo_session` `HttpOnly` (JavaScript non lo legge), `SameSite=Strict`, `Secure` quando il sito è in HTTPS; durano 30 giorni e si rinnovano usando l'app. Nel database c'è solo l'hash SHA-256 del token, non il token. Insieme c'è il cookie `meteo_auth=1`, leggibile da JavaScript e senza segreti, che dice solo "c'è una sessione": le pagine con dati (`js/auth-guard.js`) se manca vanno subito al login, prima di disegnarsi, invece di mostrare per un attimo l'app vuota. Il server lo toglie all'uscita e quando la sessione non vale più.
- **Tentativi**: dopo 5 errori in 15 minuti dallo stesso indirizzo il login risponde "troppi tentativi". Il blocco scade da solo quando il primo dei 5 errori ha più di 15 minuti (i tentativi fatti durante il blocco non lo allungano) e vale per indirizzo, non per utente. Il conteggio è solo nella memoria dell'API: per sbloccare subito, `sudo systemctl restart meteo-api` (le sessioni aperte restano valide).
- **Token personali**, per programmi senza browser come il plugin SwiftBar: si inviano con `Authorization: Bearer <token>`, non scadono e si revocano dal server.

Gestione degli utenti, solo sul server. **Va sempre fatta sul database dell'API e come suo proprietario**, altrimenti l'utente finisce in un database che il sito non legge (senza `METEO_DB` lo script userebbe `data/meteo.db` nella cartella del codice):

```bash
sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db sh -c 'cd /opt/meteo && python3 -B -m server.users <comando>'
```

| Comando | Cosa fa |
|---|---|
| `add <nome>` | crea un utente (chiede la password due volte, senza mostrarla) |
| `passwd <nome>` | cambia la password e chiude le sessioni aperte |
| `del <nome>` | elimina utente, sessioni, token e preferenze |
| `list` | utenti con ultimo accesso e sessioni aperte, token personali |
| `check <nome>` | controlla se una password è quella giusta, senza cambiare nulla |
| `token <nome> --label "…"` | crea un token personale, mostrato una sola volta |
| `revoke <nome> [--tokens]` | chiude le sessioni e revoca i token (solo i token con `--tokens`) |

Se non si riesce ad accedere:

1. `list`: controlla che l'utente ci sia e il nome esatto (lo script mostra anche quale database sta usando);
2. `check <nome>`: prova la password senza cambiare nulla;
3. `passwd <nome>`: imposta una password nuova (chiude le sessioni aperte di quell'utente);
4. se il login dice "troppi tentativi": aspettare 15 minuti o `sudo systemctl restart meteo-api`;
5. se dice "errore del server (database)": `ls -l /var/lib/meteo/` e `sudo chown meteo:meteo /var/lib/meteo/meteo.db*`.

Lo script mostra sempre quale database sta usando, non ne crea uno nuovo, avvisa se il database non contiene previsioni (quindi probabilmente non è quello dell'API) e si ferma se lo si lancia con un utente diverso dal proprietario del database: da root SQLite potrebbe creare file che l'API, utente `meteo`, poi non riesce a scrivere, e il login fallirebbe proprio con la password giusta. In quel caso il login risponde "errore del server (database)" e il dettaglio è in `journalctl -u meteo-api`.

### Come funziona

La pagina `info.html` spiega, anche con due diagrammi (percorso dei dati e calcolo del verdetto), modelli, ensemble, calcolo della probabilità, regole del verdetto, fasce e concordanza, centralina, radar, fiumi, allerte, medie del periodo, verifica e limiti, con tutte le soglie in chiaro.

Tutti gli orari sono nell'ora locale di Faenza.

### Come leggere il verdetto

Il verdetto c'è per ogni ora (striscia sotto il grafico, cella dell'ora del dettaglio orario) e per ogni fascia di 6 ore (riga sotto i box dei modelli), con le stesse regole e gli stessi colori: per la fascia si guardano i mm e la probabilità delle 6 ore insieme. Per ogni intervallo l'app controlla se ciascun modello prevede almeno 0,2 mm di pioggia, e qual è la probabilità. I modelli sono i due mostrati più, nelle prime ~48 ore, due **modelli di supporto** ad alta risoluzione aggiornati ogni 3 ore: ICON-D2 (DWD, 2,2 km) e AROME (Météo-France, 1,3 km); non hanno barre nel grafico ma compaiono nel dettaglio e nella Verifica. La probabilità è la quota di scenari con almeno 0,2 mm, come media di tre ensemble: ICON-EU-EPS (40 scenari, circa 5 giorni), ICON-D2-EPS (20 scenari a 2,2 km, circa 2 giorni) ed ECMWF ENS (51 scenari, 6 giorni). Dove un ensemble ha dati ogni 3 ore, uno scenario conta come bagnato se ha almeno 0,2 mm nelle 3 ore.

| Verdetto | Quando |
|---|---|
| Pioggia (blu) | la maggioranza dei modelli vede pioggia (entrambi su due, almeno 3 su 4) e probabilità ≥ 30%, oppure almeno un modello e ≥ 60%, oppure probabilità ≥ 80%; per oggi anche se sta piovendo adesso (ora in corso o che inizia entro 30 minuti) o se il radar vede arrivare pioggia in quell'ora entro 60 minuti |
| Asciutto (verde) | nessun modello vede pioggia e probabilità < 20% |
| Rischio (ambra) | nessun modello vede pioggia, ma probabilità ≥ 20% |
| Incerto (ambra) | tutti gli altri casi |

L'area azzurra (solo probabilità) e la striscia (probabilità + modelli + centralina e radar) possono quindi dire cose diverse: per esempio 40% di probabilità ma un solo modello su quattro con pioggia dà "Incerto". Quando le ore sono troppo strette (telefono a 72 ore o "Tutto") la striscia raggruppa le ore in blocchi di 2, 3 o 6 ore con il colore dell'ora peggiore. Per un intervallo di più ore il rischio è più alto di quello della singola ora: la probabilità che piova in almeno un'ora di un intervallo supera quella di ciascuna ora. Nel dettaglio, la sezione "Da sapere" avverte quando la probabilità va presa con cautela: ensemble in disaccordo tra loro (più di 20 punti tra il più alto e il più basso, tra il 10 e il 90%), un solo ensemble, intervallo che inizia tra più di 2 o 4 giorni. Non cambia il verdetto.

## Architettura

```
fonti esterne ──(cron)──▶ server/jobs.py ──▶ SQLite ◀── server/api.py ◀──(nginx /api/)── browser
(Open-Meteo, centralina,                                                  nginx: file statici
 radar DPC, idrometri ARPAE)
```

| Dato | Fonte | Aggiornamento sul server |
|---|---|---|
| Centralina | meteofaenza.it | ogni 10 minuti (20 s dopo lo scoccare) |
| Previsioni ICON-2I / ICON-EU (+ ICON-D2 / AROME di supporto) | Open-Meteo | controllo dei metadati ogni 15 minuti; download (tutti i modelli in una richiesta) solo se c'è un nuovo run (ICON-2I ogni 12 h, gli altri ogni 3 h) o se hanno più di 6 ore |
| Ensemble ICON-EU-EPS / ICON-D2-EPS / ECMWF ENS | Open-Meteo | ogni 3 ore (i loro metadati non sono affidabili) |
| Metadati dei run | Open-Meteo | ogni 15 minuti (pochi byte) |
| Medie del periodo 1991–2020 | archivio Open-Meteo (ERA5-Land) | controllo giornaliero, download solo se mancano o hanno più di un anno |
| Livelli di Lamone e Marzeno | ARPAE Emilia-Romagna (Allerta Meteo) | ogni 15 minuti (una richiesta per le soglie + una per stazione) |
| Radar (pioggia al suolo, SRI) | Protezione Civile | ogni 5 minuti (immagini nuove, ~780 KB l'una; servono numpy e Pillow) |

In una giornata il server fa così circa 20 download di previsioni, 8 di ensemble, 144 letture della centralina e 288 immagini radar (~225 MB), qualunque sia il numero di utenti.

Job notturni (orari in `deploy/crontab`):

- **04:40, `normals`**: salva gli esiti della verifica dei giorni conclusi, pulisce gli archivi, scarica le medie del periodo se servono;
- **04:50, `backup`**: copia coerente del database (API di backup di SQLite), controllata e compressa in `/var/lib/meteo/backup` (variabile `METEO_BACKUP_DIR`); restano le ultime 7.

### API

Tutte richiedono l'accesso (cookie di sessione o token personale; senza: `401`), tranne login e logout e `api/status` chiesto direttamente sul server (`curl http://127.0.0.1:8085/api/status`, senza passare da nginx). Le letture hanno un `ETag`: il browser rivalida e riscarica solo se i dati sono cambiati.

| Percorso | Contenuto |
|---|---|
| `api/forecast` | previsioni dei modelli (da ieri alle 23), scenari degli ensemble e metadati dei run |
| `api/station` | ultima misura della centralina (valori del giorno da mezzanotte), letture delle ultime 2 ore, riepilogo del radar, ultimo giorno di pioggia (`lastRain`: data locale, istante, mm di quel giorno) e nuvolosità osservata (`clouds`: copertura, fonte `sun` o `metar`, `kind` `total` o `min` = solo nubi basse) e allerte di oggi e domani della zona B1 (`alerts`: livello 0–3 per fenomeno, bollettino con numero, testo e PDF) |
| `api/radar` | radar: riepilogo, stima dei prossimi 90 minuti, elenco delle immagini e geometria della cartina (città, costa, confini) |
| `api/radar/<nome>.png` | immagini dell'animazione (misurate e stimate) |
| `api/rivers` | livelli di Lamone e Marzeno: soglie, ultimo valore, tendenza e serie di 48 ore per stazione |
| `api/normals` | medie del periodo (366 giorni) |
| `api/verify?days=30&lead=1` | esiti della verifica per giorno: misure delle fasce e del giorno, previsto ed esito per ogni modello, probabilità degli ensemble, minime e massime; `lead=1` previsione del giorno prima alle 23, `lead=2` di due giorni prima |
| `api/status` | stato dei job (ultimo aggiornamento, errori) |
| `api/me` | utente collegato |
| `api/settings` | preferenze dell'utente (`null` se non ne ha ancora) |
| `POST api/settings` | `{"settings": {chiave: valore}}`: unisce le modifiche (solo valori ammessi) e restituisce le preferenze |
| `POST api/login` | `{"username", "password"}` (solo JSON) → cookie di sessione |
| `POST api/password` | `{"current", "new"}` (solo JSON, con la sessione) → nuova password; 403 se quella attuale è sbagliata, 400 se la nuova non va bene; chiude le altre sessioni e rimanda il cookie |
| `POST api/logout` | chiude la sessione |

### Dati conservati

| Dati | Per quanto |
|---|---|
| Letture della centralina, archivio delle previsioni (ogni run, ora per ora) e degli ensemble (quali scenari danno pioggia), livelli dei fiumi, allerte della zona di Faenza (un giorno per riga), dato radar su Faenza, bollettini METAR | circa 400 giorni |
| Esiti della verifica (un record per giorno e per anticipo) | 2 anni, anche dopo che i dati grezzi sono stati tolti |
| Immagini e ritagli del radar | 3 ore |
| Utenti (nome, hash della password, ultimo accesso), preferenze e token personali | finché non si eliminano o revocano |
| Sessioni del browser | 30 giorni dall'ultimo uso |
| Registro dei job | 30 giorni |
| Copie del database | ultime 7 notti |

Gli esiti della verifica si calcolano una volta sola, nella notte dopo la fine del giorno, e non si rielaborano: se cambiano le regole di giudizio, i giorni già salvati restano giudicati con quelle di allora. Per rigiudicare i giorni di cui ci sono ancora i dati grezzi: `python3 -m server.jobs verify --force`.

## Cosa fa il server e cosa fa il browser

La regola generale: il **server** fa tutto ciò che richiede fonti esterne, storico, calcoli pesanti o che deve valere uguale per tutti; il **browser** fa ciò che dipende dalle preferenze di chi guarda (modelli mostrati, tema, grafico) e dall'ora attuale, partendo dai dati già pronti del server.

### Lato server (`server/`)

| Logica | Dove |
|---|---|
| Interrogare tutte le fonti esterne, a orari fissi via cron, e decidere quando scaricare le previsioni (dai metadati dei run) | `jobs.py`, `sources.py` |
| Normalizzare le risposte di Open-Meteo (variabili con suffisso del modello, scenari degli ensemble per gruppo) | `sources.py` |
| Leggere il file della centralina estraendo i valori senza eseguirlo; ricalcolare i valori del giorno da mezzanotte locale (pioggia, minima, massima, raffica) dalle letture salvate; fornire le letture delle ultime 2 ore per capire se sta piovendo | `sources.py`, `api.py`, `verify.py` |
| Calcolare le medie del periodo 1991–2020 per ogni giorno dell'anno (finestra di ±7 giorni) | `sources.py` |
| Tagliare le previsioni al momento della richiesta ("da ieri alle 23") e allineare gli orari dell'ensemble | `api.py` |
| Radar: lettura del GeoTIFF, ritaglio attorno a Faenza, calcolo del movimento della pioggia, stima dei prossimi 90 minuti, immagini PNG, riepilogo per la centralina | `radar.py` (numpy, Pillow) |
| Fiumi: soglie, serie di 48 ore, livello di allerta e tendenza per stazione | `rivers.py` |
| Allerte: colore della zona B1 per fenomeno (oggi e domani) e feed dei bollettini; solo la zona, non il riassunto per province | `alerts.py` |
| Nuvolosità osservata: METAR di Forlì e Bologna, quota di sole che passa dalla radiazione della centralina (con taratura automatica), stima per `api/station` | `clouds.py` |
| Verifica: archivio di ogni run e degli scenari degli ensemble; pioggia oraria misurata dalle letture (con azzeramento della centralina e cambio dell'ora); esiti per fascia e per giorno, probabilità, minime e massime; salvataggio degli esiti dei giorni conclusi | `verify.py` |
| Accesso: verifica delle password (hash), sessioni e token, blocco dei tentativi ripetuti, controllo su ogni richiesta all'API; creazione degli utenti con uno script | `auth.py`, `api.py`, `users.py` |
| Preferenze per utente: salvataggio e controllo dei valori ammessi | `prefs.py`, `api.py` |
| Manutenzione degli archivi, delle sessioni scadute e backup del database | `db.py`, `jobs.py` |

### Lato browser (`js/`)

| Logica | Dove |
|---|---|
| Quando chiedere i dati al server: previsioni ogni 10 minuti (con ETag), centralina ai minuti :00, :10…, fiumi ogni 15 minuti; sospensione con l'app in background | `app.js`, `api.js` |
| Copia offline delle previsioni e dell'ultima misura, scadenza dopo un giorno; copia di lettura delle preferenze, invio delle modifiche al server (anche dopo, se si è offline) e riallineamento a ogni apertura | `storage.js` |
| Fasce di 6 ore: icona pesata sulla fascia, temperatura media, pioggia; totale del giorno | `app.js` |
| Probabilità di pioggia di fasce e ore dagli scenari degli ensemble (media tra ensemble, dati ogni 3 ore) | `app.js` (`windowRainChance()`) |
| Concordanza dei modelli | `app.js` (`agreement()`) |
| Verdetto ora per ora (modelli mostrati e di supporto, probabilità, pioggia in corso, radar) e temperatura media dell'ora | `app.js` (`hourVerdict()`), `radar.js` |
| Pioggia in corso dalle ultime letture della centralina | `app.js` (`stationRainNow()`) |
| Temperatura corretta con la centralina nel grafico | `app.js` (`tempFix()`) |
| Nuvolosità corretta con quella osservata: grafico e icone delle fasce di oggi | `app.js` (`cloudFix()`, `cloudCode()`) |
| Verdetto delle fasce (stesse regole delle ore) e avvertenze "Da sapere" sulla probabilità | `app.js` (`slotVerdicts()`, `chanceCaveats()`) |
| Scarti dalla media del periodo | `app.js` (`anomaly()`) |
| Grafico SVG, tabella oraria, linea di alba e tramonto, animazione del radar, sezione dei fiumi | `chart.js`, `app.js`, `radar.js`, `rivers.js` |
| Pagina di accesso; passaggio al login quando il server risponde 401, con cancellazione delle copie dei dati; uscita dalle Impostazioni | `login.js`, `api.js`, `settings.js`, `storage.js` |
| Verifica: riepilogo del periodo (conteggi degli esiti, errori medi, affidabilità, Brier) dagli esiti già calcolati dal server | `verify.js` |
| Tema applicato prima del primo disegno | `theme.js` |

Le probabilità e i verdetti sono calcolati nel browser perché dipendono dai modelli scelti nelle Impostazioni e dall'ora attuale; il server fornisce gli scenari completi degli ensemble. La verifica invece è calcolata sul server, perché richiede lo storico e deve restare uguale nel tempo.

## Avvio in locale

Serve Python 3.9 o successivo; il radar richiede anche numpy e Pillow (`apt install python3-numpy python3-pil` su Debian, oppure in un ambiente virtuale), il resto solo la libreria standard:

```bash
python3 -m server.jobs all          # primo popolamento del database (data/meteo.db)
python3 -m server.users add <nome>  # un utente per accedere (nel database data/meteo.db creato dal comando sopra)
python3 -m server.api --static      # API + file del frontend su http://127.0.0.1:8085
```

poi aprire <http://127.0.0.1:8085> e accedere. In locale i job si rilanciano a mano (`python3 -m server.jobs station`, `forecast`, `normals`, `radar`, `rivers`, `alerts`, `clouds`, `verify`, `backup`; `--force` per forzare). Il database è in `data/meteo.db` (variabile `METEO_DB` per cambiarlo), escluso da git. Test: `python3 -m unittest discover -s tests`.

Il service worker funziona solo su `http://localhost`/`127.0.0.1` o in HTTPS.

Attenzione: l'archivio storico di Open-Meteo (per le medie) vale molte chiamate; con prove ripetute risponde "troppe richieste" (429) per un po'.

## Installazione sul server (Linux + nginx)

Guida completa, passo per passo: [`deploy/INSTALL.md`](deploy/INSTALL.md). In breve:

1. Pacchetti: `apt install git python3 python3-numpy python3-pil nginx` (numpy e Pillow servono solo al job del radar). Codice in `/opt/meteo` (es. `git clone`), utente di servizio e cartella del database:
   ```bash
   useradd --system --home /var/lib/meteo meteo
   mkdir -p /var/lib/meteo && chown meteo:meteo /var/lib/meteo
   ```
2. Primo popolamento e primo utente: `sudo -u meteo env METEO_DB=/var/lib/meteo/meteo.db sh -c 'cd /opt/meteo && python3 -m server.jobs all'`, poi lo stesso comando con `python3 -m server.users add <nome>`.
3. API come servizio: `deploy/meteo-api.service` in `/etc/systemd/system/`, poi `systemctl enable --now meteo-api` (ascolta solo su `127.0.0.1:8085`).
4. Aggiornamenti e job notturni: `crontab -u meteo deploy/crontab` (log con `journalctl -t meteo`).
5. nginx: `deploy/nginx-meteo.conf` in `/etc/nginx/sites-available/`, adattare `server_name`, collegare in `sites-enabled`, `nginx -t && systemctl reload nginx`; HTTPS con `certbot --nginx`. La configurazione non espone `server/`, `data/`, `tests/`, `deploy/` e `swiftbar/`. Per installare l'app in una sottocartella c'è una variante commentata nello stesso file.

Controllo, sul server: `curl -s http://127.0.0.1:8085/api/status`. Usare HTTPS: senza, la password viaggia in chiaro.

### Aggiornare l'app

- Dopo ogni modifica ai file del frontend va incrementato `VERSION` in `sw.js` (è anche il numero mostrato in fondo alla pagina): altrimenti chi ha già aperto l'app continua a vedere la versione salvata nel browser. Un file nuovo del frontend va aggiunto anche all'elenco `SHELL` di `sw.js`.
- Dopo una modifica al server: `systemctl restart meteo-api` (i job li rilegge cron a ogni esecuzione).
- Se cambia la forma di `api/forecast`, incrementare `FORECAST_SCHEMA` sia in `server/config.py` sia in `js/storage.js`.
- Ripristino da un backup: vedi `deploy/INSTALL.md`.

## Plugin per la barra dei menu del Mac (SwiftBar)

`swiftbar/meteo-faenza.5m.py` mostra la temperatura della centralina nella barra dei menu e, nel menu, tutte le misure della giornata: massima e minima (con lo scarto dalla media del periodo), percepita, pioggia (e se sta piovendo), umidità, pressione, vento, radiazione, totali del mese e dell'anno, dati del sole. Legge i dati dal server (`api/station`, `api/normals`), non dalla centralina; si aggiorna ogni 5 minuti (lo dice il nome del file).

Installazione: [SwiftBar](https://swiftbar.app) e poi

```bash
chmod +x swiftbar/meteo-faenza.5m.py
ln -s "$PWD/swiftbar/meteo-faenza.5m.py" "<cartella dei plugin di SwiftBar>/"
```

Il plugin ha bisogno di un **token personale**, da creare sul server con il comando `token <nome> --label "SwiftBar"` dello script degli utenti (vedi [Accesso](#accesso), sempre con `METEO_DB` e come utente `meteo`) e da mettere nel file `~/.config/meteo-faenza/token` (consigliato `chmod 600`) o nella variabile `METEO_TOKEN`. Senza token, o con un token revocato, il menu lo segnala.

Server diverso da `https://meteofa.melandri.net`: variabile `METEO_URL` (in SwiftBar, con `<swiftbar.environment>` o modificando `BASE_URL` nel file). Serve solo Python 3, senza pacchetti aggiuntivi.

## Installazione su telefono

L'app è una PWA: da Chrome o Edge si installa con l'icona nella barra degli indirizzi, da Safari su iPhone con *Condividi → Aggiungi alla schermata Home*.

## Personalizzazione

Tema, modelli mostrati, grafico e sezioni si scelgono dalla pagina Impostazioni. Il resto è nelle costanti del codice:

| Cosa | Dove |
|---|---|
| Località (nome, coordinate, quota) | `LOCATION` in `js/app.js`; `LAT`, `LON`, `TIMEZONE` in `server/config.py` |
| Soglie del verdetto ora per ora | `VERDICT_WET_MM`, `VERDICT_POP_MOST`, `VERDICT_POP_ONE`, `VERDICT_POP_ANY`, `VERDICT_POP_DRY` in `js/app.js` |
| Fasce del giorno (icone, soglie di pioggia) | `SLOTS`, `SLOT_*` in `js/app.js` |
| Pioggia in corso dalla centralina | `RAIN_NOW_*` in `js/app.js` |
| Correzione della temperatura con la centralina | `TEMP_FIX_*` in `js/app.js` |
| Soglie della concordanza dei modelli | `AGREE` in `js/app.js` |
| Giorni mostrati nella scheda Previsioni | `DAILY_DAYS` in `js/app.js` |
| Ensemble usati per la probabilità | `ENSEMBLE_MODELS` in `server/sources.py` |
| Modelli di supporto (ICON-D2, AROME) | `SUPPORT_MODELS` in `server/sources.py` e `js/api.js` |
| Stazioni dei fiumi | `RIVERS` in `server/sources.py` |
| Radar: soglie della stima, riquadro della cartina, città | `RAIN_MMH`, `ARRIVE_FRAC`, `MAYBE_FRAC`, `VIEW_HALF`, `CITIES` in `server/radar.py`; `RADAR_VERDICT_MIN` in `js/radar.js` |
| Regole della verifica | `WET_MM`, `QTY_RATIO`, `QTY_MM`, `CUTOFF_HOUR` in `server/verify.py` |
| Conservazione dei dati | `STATION_KEEP_DAYS`, `VERIFY_KEEP_DAYS`, `RADAR_KEEP_S`, `BACKUP_KEEP` in `server/config.py` |
| Frequenza degli aggiornamenti del server | `deploy/crontab` e `*_MAX_AGE_S` / `ENSEMBLE_EVERY_S` in `server/config.py` |
| Ogni quanto il browser ricontrolla il server | `CACHE_TTL_MS` in `js/storage.js` |
| Accesso: durata delle sessioni, lunghezza minima della password, blocco dei tentativi | `SESSION_DAYS`, `MIN_PASSWORD`, `MAX_FAILURES`, `FAIL_WINDOW_S` in `server/auth.py` |

Se si cambiano soglie o regole, va aggiornata anche la pagina `info.html`, che le riporta in chiaro.

La centralina è specifica di Faenza: cambiando località va sostituita o rimossa (`server/sources.py` e `js/station.js`).

## Struttura

```
index.html             pagina principale (centralina, previsioni, grafico, radar, fiumi, dettaglio orario)
info.html              pagina "Come funziona"
settings.html          pagina Impostazioni
verify.html            pagina Verifica (previsioni confrontate con le misure)
login.html             pagina di accesso
css/style.css          stile (tema chiaro e scuro)
js/theme.js            applica il tema scelto prima che la pagina compaia
js/app.js              logica e rendering della pagina principale
js/settings.js         pagina Impostazioni
js/verify.js           pagina Verifica
js/login.js            pagina di accesso
js/api.js              accesso all'API del server
js/station.js          misure della centralina (dall'API)
js/radar.js            radar: riga del box della centralina, verdetto di oggi, sezione con l'animazione
js/rivers.js           sezione Fiumi
js/storage.js          copie nel browser (localStorage) e sincronizzazione delle preferenze con il server
js/chart.js            grafico SVG (con la striscia del verdetto)
js/weather.js          icone meteo e formattazione
sw.js                  service worker (funzionamento offline, versione dell'app)
manifest.webmanifest   metadati PWA
icons/                 icone dell'app
server/config.py       configurazione (località, database, frequenze, conservazione)
server/sources.py      download e normalizzazione delle fonti esterne
server/jobs.py         job di aggiornamento, verifica e backup (lanciati da cron)
server/api.py          API JSON (e file statici in locale)
server/db.py           database SQLite e pulizia
server/verify.py       archivio delle previsioni, esiti della verifica
server/auth.py         accesso: hash delle password, sessioni, token, blocco dei tentativi
server/users.py        script per creare e gestire gli utenti
server/prefs.py        preferenze degli utenti (api/settings)
server/rivers.py       livelli dei fiumi
server/alerts.py       allerte della zona di Faenza (Allerta Meteo Emilia-Romagna)
server/clouds.py       nuvolosità osservata (radiazione della centralina, METAR)
server/radar.py        radar: lettura delle immagini, movimento, stima, immagini PNG (numpy, Pillow)
tests/                 test del server (senza rete)
swiftbar/              plugin SwiftBar per la barra dei menu del Mac
deploy/                nginx, systemd, crontab, guida di installazione (INSTALL.md)
docs/diagrams/         sorgenti (sintassi Mermaid) dei diagrammi di info.html
tools/diagrams.mjs     disegna i diagrammi con Pele e li inserisce in info.html (a mano, solo se cambiano)
```

## Fonti dei dati

- Previsioni, ensemble e metadati dei modelli: [Open-Meteo](https://open-meteo.com/) (licenza CC BY 4.0).
- Medie del periodo 1991–2020: reanalisi ERA5-Land (Copernicus Climate Change Service), dall'archivio storico di Open-Meteo.
- ICON-2I © [ItaliaMeteo-ARPAE](https://www.arpae.it/); ICON-EU, ICON-D2, ICON-EU-EPS e ICON-D2-EPS © [Deutscher Wetterdienst](https://www.dwd.de/); AROME © [Météo-France](https://meteofrance.com/); ECMWF ENS © [ECMWF](https://www.ecmwf.int/) (CC BY 4.0).
- Misure: Osservatorio Meteorologico "E. Torricelli", [meteofaenza.it](https://www.meteofaenza.it/).
- Nuvolosità osservata di notte: bollettini METAR degli aeroporti di Forlì e Bologna, dal [NOAA Aviation Weather Center](https://aviationweather.gov/).
- Livelli dei fiumi: [ARPAE Emilia-Romagna – Allerta Meteo](https://allertameteo.regione.emilia-romagna.it/) (API del portale, non documentata come servizio pubblico).
- Allerte: [Allerta Meteo Emilia-Romagna](https://allertameteo.regione.emilia-romagna.it/) (ARPAE e Agenzia regionale per la sicurezza territoriale e la protezione civile): stato delle zone di allerta (stessa API dei fiumi, non documentata) e feed Atom dei bollettini.
- Radar: [Dipartimento della Protezione Civile](https://radar.protezionecivile.it/), licenza CC BY-SA 4.0 (con la stessa licenza le immagini radar prodotte dall'app). Costa nell'immagine: Natural Earth (dominio pubblico); confini di regione: ISTAT (CC BY, tramite openpolis/geojson-italy).

Nota tecnica sulla centralina: il suo file dati è un piccolo file JavaScript con le variabili delle misure. Lo legge il server, che ne estrae i valori senza eseguirlo; il browser non lo carica.

## Privacy

Oltre ai dati meteo (previsioni, misure della centralina, medie, radar, livelli dei fiumi, allerte, esiti della verifica), il server conserva solo i dati di accesso: nome utente, hash della password (non reversibile), data dell'ultimo accesso hash dei token di sessione e personali, e le preferenze di visualizzazione (tema, modelli mostrati, grafico, sezioni, verifica). Nel `localStorage` del browser restano solo copie per l'uso offline (preferenze, previsioni al massimo di un giorno prima, ultima misura), cancellate quando si esce. Come ogni server web, nginx registra nei suoi log gli indirizzi IP delle richieste.
