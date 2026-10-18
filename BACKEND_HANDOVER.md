# MwM Backend Handover & Run Guide

Guida operativa per avviare, configurare e testare il backend di Money with Memory (MwM) su una macchina nuova (macOS Apple Silicon o Linux). Tutti i comandi vanno lanciati dalla root del repository.

---

## 1. Architettura & Requisiti

Il backend orchestra:
* **Bitcoin regtest + electrs + RGB proxy**: container Docker Compose (`compose.yaml`) gestiti da `scripts/regtest.sh`.
* **`rgb_lib` 0.3.0b7 patchata**: binding Python di rgb-lib (PR #85 + patch MwM) per wallet, emissione NIA e atomic swap RGB↔RGB on-chain.
* **QVAC**: LLM locale OpenAI-compatibile (modello `buyer-agent`, porta 11435) che genera i turni di buyer e seller.
* **FastAPI** (`backend/api_server.py`): API REST per wallet, mercato, contatti e sessioni di negoziazione e regolamento.

### Prerequisiti
* macOS Apple Silicon oppure Linux.
* **Docker** (su macOS Docker Desktop o OrbStack) con il plugin `docker compose`. Il backend lancia `scripts/regtest.sh` (cioè `docker compose exec`) per minare e inviare BTC: server e Docker devono stare sulla stessa macchina e l'utente deve poter usare `docker` senza `sudo`.
* **Python 3.13**.
* **`rgb_lib` 0.3.0b7 patchata**: non è su PyPI (vedi Passo 2).
* **Node.js**: ≥ 23.6 per il contract check (verificato con Node 26) e **22** per il servizio Vault (`vault/`): il binding nativo di `@utexo/rgb-lib` non compila su Node 24+ e `vault/.npmrc` impone `engine-strict` (vedi `vault/README.md`). `scripts/demo_reset.sh` trova Node 22 da solo, oppure usa `VAULT_NODE`.
* **QVAC** con il modello `buyer-agent` (`qvac.config.json`), sulla stessa macchina o in LAN. Senza QVAC si può usare `QVAC_MOCK=1`.

---

## 2. Setup Passo-Passo

### Passo 1: Avviare regtest (bitcoind, electrs, proxy)
```bash
./scripts/regtest.sh start
```
Lo script avvia bitcoind e proxy, attende bitcoind, crea o carica il wallet `miner`, mina fino all'altezza 111, poi avvia electrs e attende che sia pronto (stampa `regtest ready, height N`). Verifica:
```bash
./scripts/regtest.sh height
docker compose ps
```
Porte: bitcoind `18443`, electrs `50001`, proxy `3000`. I nomi dei container dipendono dalla cartella del checkout (`<cartella>-bitcoind-1`, ...), quindi controllali con `docker compose ps`. `./scripts/regtest.sh stop` ferma i servizi senza perdere la chain; per azzerarla vedi §4.

### Passo 2: Ambiente Python e `rgb_lib` patchata
```bash
python3.13 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
```

`rgb_lib` 0.3.0b7 si compila da rgb-lib PR #85 (commit in `patches/PR85_PINNED_SHA.txt`) con `patches/mwm-pr85-experimental-fixes.patch`. Non si installa da PyPI.

**macOS Apple Silicon (build pronta).** Procurati fuori da git (es. via AirDrop da chi ha già la build; le `.dylib` sono in `.gitignore`) le cartelle `rgb_lib/` e `rgb_lib-0.3.0b7.dist-info/` di una build funzionante (cp313, arm64) e copiale nel venv:
```bash
SRC=~/Downloads/rgb-lib-build   # adatta: la cartella che contiene rgb_lib/ e rgb_lib-0.3.0b7.dist-info/
SITE=.venv/lib/python3.13/site-packages
cp -R "$SRC/rgb_lib" "$SRC/rgb_lib-0.3.0b7.dist-info" "$SITE/"
xattr -dr com.apple.quarantine "$SITE/rgb_lib" "$SITE/rgb_lib-0.3.0b7.dist-info"
ls "$SITE/rgb_lib"
```
`rgb_lib/` deve contenere `__init__.py`, `rgb_lib.py` e `libuniffi.dylib`, il file che i binding caricano davvero. Se c'è solo `librgblibuniffi.dylib`, copialo con quel nome:
```bash
cp "$SITE/rgb_lib/librgblibuniffi.dylib" "$SITE/rgb_lib/libuniffi.dylib"
```
Verifica (non stampa chiavi):
```bash
.venv/bin/python -c "import rgb_lib; rgb_lib.generate_keys(rgb_lib.BitcoinNetwork.REGTEST, rgb_lib.WitnessVersion.SEG_WIT_V0); print('rgb_lib OK')"
```

**Linux (o per ricompilare).** Non c'è una build pronta e serve la toolchain Rust: compila `rgb-lib-python` con il submodule `rgb-lib` al commit fissato più la patch e installalo nel venv (passi nel `README.md`, §3). Su Linux i binding cercano `rgb_lib/libuniffi.so` (stessa regola sul nome).

### Passo 3: Configurare QVAC
Sulla macchina che ospita QVAC (comando dal `README.md`, §4; servono la CLI `qvac` e i pesi del modello):
```bash
qvac serve --openai --port 11435 --config qvac.config.json
```
Variabili lette dal backend (`backend/config.py`):

| Variabile | Default | Note |
|---|---|---|
| `QVAC_BASE_URL` | `http://127.0.0.1:11435/v1` | Va bene se QVAC gira sulla stessa macchina; altrimenti `http://<IP_HOST_QVAC>:11435/v1` |
| `QVAC_API_KEY` | vuota | Se è vuota il backend legge `~/.mwm/qvac.key` (una riga). Non committarla mai |
| `QVAC_MODEL` | `buyer-agent` | Nome del modello in `qvac.config.json` |
| `QVAC_MOCK` | `0` | `1` = negoziatore mock deterministico senza chiamate a QVAC (`/api/health` riporta `qvac: true`) |
| `MWM_DATA_DIR` | `~/.mwm/data` | Wallet rgb-lib: `<wallet_id>/keys.json` + database |
| `NEGOTIATION_MAX_ROUNDS` | `10` | Tetto di sicurezza sui round di trattativa |
| `NEGOTIATION_CONCURRENCY` | `1` | Trattative che usano QVAC contemporaneamente; le altre aspettano in coda |
| `ELECTRUM_URL`, `PROXY_URL` | `127.0.0.1:50001`, `http://127.0.0.1:3000/json-rpc` | Servizi del Passo 1 |
| `VAULT_URL`, `VAULT_TIMEOUT` | `http://127.0.0.1:8200`, `30` | Servizio Vault (`vault/`) e timeout in secondi di ogni chiamata del backend (§6) |
| `SATS_PER_USD` | `1000` | Cambio simulato BTC/USD (1.000 sats = 1 USD): lo mostra `/api/market` e lo usano tutti i `total_usd` (§5.3). Un valore ≤ 0 blocca l'avvio |

Se QVAC non risponde durante una negoziazione, il backend passa al mock senza errori per il frontend: resta solo un warning nei log (`QVAC live call failed ... Falling back to internal mock`).

### Passo 4: Avviare il server FastAPI
Regtest deve essere già attivo. In un terminale dedicato:
```bash
QVAC_BASE_URL=http://127.0.0.1:11435/v1 \
.venv/bin/uvicorn backend.api_server:app --host 0.0.0.0 --port 8000
```
Senza QVAC metti `QVAC_MOCK=1` al posto di `QVAC_BASE_URL=...`.

Per i movimenti Wallet ↔ Vault serve anche il servizio Vault, in un altro terminale: `cd vault && npm ci && npm start`, con Node 22 (vedi `vault/README.md`). Senza, `move_to_vault` risponde `503 vault_unavailable` e il Wallet mostra il Vault come non disponibile.

All'avvio (lifespan → `RgbSwapEngine.setup_demo_environment`) il backend prepara da solo la demo. `backend/seed.py` contiene solo i parametri dei wallet seed e non va eseguito.
* Finanzia Wallet A, Wallet B e Sybil con `initial_btc_sats` di `backend/seed.py` (1.000.000 sats = 0,01 BTC per A e B, 500.000 per Sybil) e crea su ciascuno 5 UTXO colorabili da 10.000 sats.
* Riusa gli asset demo dei riavvii precedenti, così i saldi non si dividono tra asset id diversi. Tra gli asset con quel ticker sceglie quello con il saldo `future` più alto (a parità, l'ultimo aggiunto):
  * PEPE: uno che Wallet B possiede ancora (saldo sopra 0). Se B non ne ha più, perché ha venduto l'intero lotto (anche con un acquisto del lotto intero nello Shop) o l'ha spostato tutto nel Vault, emette un lotto nuovo di 1.000.000 PEPE su B, con un nuovo asset id (§4).
  * USDT: uno che Wallet A conosce, anche a saldo 0 (per esempio dopo aver spostato tutti i suoi USDT nel Vault), perché il resto è ancora da B o nel Vault e deve poter tornare. Emette 10.000 USDT su A solo se A non ne conosce nessuno: al primo avvio o dopo un reset completo.
* Il desk di Wallet B riparte dal lotto seminato di 1.000.000 PEPE (i profili vivono in RAM), ma elenca al massimo quello che B possiede: se ne ha meno (parte venduta o spostata nel Vault) il lotto si riduce a quella quantità, agli stessi prezzi unitari, come dopo una vendita (`fit_lot`).
* Anche la storia dei saldi (`history_points`) vive in RAM: riparte da un punto con quello che ogni wallet possiede all'avvio (BTC e i due asset demo), non dalle quantità seminate. Se il saldo di un wallet non si legge, quel wallet riparte dalle quantità seminate.
* Precarica nello Shop le due richieste demo del mock del frontend (`want_seed_1`, `want_seed_2`).

Nei log compare `Demo environment ready: PEPE=... USDT=...`, preceduto per ciascun asset da `Reusing PEPE <id>: wallet_b holds N.` oppure da `wallet_b has no PEPE to reuse: issuing 1000000 PEPE on it...` (lo stesso per USDT su `wallet_a`). Ai riavvii successivi i BTC arrivano solo se un wallet ne ha meno di metà di quelli iniziali, e le UTXO colorabili vengono solo riportate a 5.

Se regtest non risponde all'avvio, nei log compare `Demo environment setup deferred (regtest offline or starting)`. Il setup **non viene ritentato**, i wallet aperti con electrs spento restano offline e `/api/market` mostra asset id segnaposto (`rgb:pepe_nia`, `rgb:usdt_nia`). Avvia regtest e riavvia il server.

Verifica:
```bash
curl -s http://127.0.0.1:8000/api/health
# Output atteso: {"regtest":true,"qvac":true,"proxy":true}
```
`--host 0.0.0.0` espone l'API sulla LAN senza autenticazione (`GET /api/wallets/{id}` include i limiti segreti dell'agente): usala solo su regtest e in una rete fidata.

---

## 3. Test e Verifica di Conformità

### Test unitari backend
```bash
.venv/bin/pytest
```
`pytest.ini` imposta `pythonpath = .` e `testpaths = backend/tests`. I test (li conta `.venv/bin/pytest --collect-only -q`) coprono API, gate, punteggio di affidabilità e accordi abbandonati, Vault (`test_vault_link.py`), Advisor, guardie del negoziatore, coda, macchina a stati delle sessioni e controlli 2/2 dello swap; lo swap on-chain reale si verifica solo con il contract check `--e2e`. Regtest e QVAC non devono essere attivi, ma `rgb_lib` deve essere nel venv. La suite è ermetica: `backend/tests/conftest.py` usa un `MWM_DATA_DIR` temporaneo e `QVAC_MOCK=1` di default (con `QVAC_MOCK=0` usa QVAC reale), quindi non tocca i wallet reali e non chiama QVAC.

### Contract check (frontend → backend)
Lo script è `frontend/scripts/contract-check.mjs` e importa solo `src/api/types.ts` e `src/api/mock/sha256.ts`, quindi non serve `npm install`. Dalla root, con Node ≥ 23.6:
```bash
node frontend/scripts/contract-check.mjs http://127.0.0.1:8000
```

*Esito atteso*: `OK: 0 failed, 0 warnings`, in pochi secondi con `QVAC_MOCK=1` e in 2-4 minuti con QVAC reale (una trattativa dura in media circa 160 s, vedi `evals/README.md`). Senza `--e2e` lo script crea tre sessioni brevi, non sposta fondi e non tocca i punteggi: una bloccata dal gate (indirizzo sconosciuto), una annullata prima dell'accordo, una con accordo lasciata senza firme che scade dopo 600 s senza abbandono (non firmarla dalla UI). Se gli agenti non trovano un accordo compare un `WARN` e i controlli di firma vengono saltati: rilancia lo script.


### E2E con negoziazione live e atomic swap on-chain
Negoziazione AI, doppia firma delle parti e regolamento RGB a 7 step su regtest:
```bash
node frontend/scripts/contract-check.mjs http://127.0.0.1:8000 --e2e
```
*Esito atteso*: `OK: 0 failed, 0 warnings`, con `SETTLED in ~7.5s` dopo la seconda firma. Lo swap sposta l'intero lotto di 1.000.000 PEPE da Wallet B a Wallet A e gli USDT concordati da A a B. Senza riavvio il desk di B resta spento (lotto esaurito): un nuovo run fallisce su `Wallet B desk sells the demo PEPE` e una nuova sessione verso B riceve `409 seller_desk_inactive`. Per rilanciare `--e2e` basta `./scripts/demo_reset.sh --restart`: B non ha più PEPE, quindi il setup emette un lotto nuovo di 1.000.000 PEPE con un nuovo asset id (§4).

---

## 4. Reset dello stato demo

Un riavvio senza reset riusa gli asset demo (Passo 4): dopo una vendita parziale, un acquisto o uno spostamento nel Vault gli asset id restano gli stessi, i saldi non si dividono e quello che custodisce il Vault resta dello stesso asset. L'USDT resta sempre lo stesso. Il PEPE cambia solo se Wallet B non ne ha più: dopo che ha venduto l'intero lotto (un `--e2e` o un acquisto del lotto intero nello Shop) o l'ha spostato tutto nel Vault. Al riavvio B riceve un lotto nuovo con un nuovo asset id, e i PEPE dell'asset vecchio, in Wallet A o in un Vault, spariscono dall'API, che mostra solo gli asset demo correnti. Quelli nel Vault non possono più tornare nel wallet (`receive_invoice` risponde `400 invalid_request`). Prima di un `--restart` lascia quindi almeno 1 PEPE in Wallet B, oppure fai un reset completo.

Per ripartire da zero c'è un comando unico:
```bash
./scripts/demo_reset.sh            # reset completo: chain nuova, wallet nuovi, nuovi asset id
./scripts/demo_reset.sh --restart  # solo riavvio del backend: chain e wallet restano
```
Lo script ferma il Vault in ascolto sulla porta 8200 (solo se è `vault/src/main.js` di questo checkout) e il backend sulla porta 8000 (solo se è `uvicorn backend.api_server:app`); se una delle due porte è di un altro programma si ferma con un errore. Nel reset completo esegue `regtest.sh reset` e cancella `${MWM_DATA_DIR:-$HOME/.mwm/data}` (memoria compresa: al riavvio la storia demo viene riseminata) e `${MWM_VAULT_DIR:-$HOME/.mwm/vault}` (frasi cifrate e dati RGB dei Vault). Avvia regtest, poi il backend in background con il log in `~/.mwm/logs/backend.log`, e dopo il backend il Vault con Node 22 (log in `~/.mwm/logs/vault.log`; senza Node 22 o senza `vault/node_modules` stampa solo un `WARN`). Con `--restart` la memoria (`memory_graph.json`) e i Vault restano, ma ogni Vault riparte bloccato: sbloccalo dalla UI o rilancia `vault/scripts/prefund.mjs`. Aspetta `Demo environment ready` e stampa health di backend e Vault, asset id, saldi e i valori di `VITE_API_TARGET` e `VITE_VAULT_TARGET` per il frontend (`VITE_API_MODE=http`; il Vault si apre solo su questa macchina). Le variabili `QVAC_*` passano al backend.

Per seguire una prova dal terminale, in sola lettura:
```bash
.venv/bin/python scripts/watch_demo.py   # una riga per ogni cambio: sessioni, round, firme, passi dello swap, saldi
tail -f ~/.mwm/logs/backend.log          # dettaglio del backend: turni QVAC e i 7 passi rgb-lib
```
* `reset` cancella container e volumi (chain nuova). Cancella sempre anche il data dir e i Vault, perché i loro wallet fanno riferimento alla chain precedente. `~/.mwm/qvac.key` non viene toccato.
* Al riavvio il backend crea wallet nuovi (nuove mnemonic e nuovi indirizzi), li finanzia ed emette gli asset demo.
* Il reset è **obbligatorio una volta** dopo il pull della modifica `vanilla_keychain=0`: un data dir creato con keychain 1 non si riapre (errore rgb-lib `Descriptor mismatch`).
* Per azzerare **solo la memoria** (punteggi, accordi abbandonati e swap ricordati) senza toccare chain e wallet: `rm "${MWM_DATA_DIR:-$HOME/.mwm/data}/memory_graph.json" && ./scripts/demo_reset.sh --restart`. Al riavvio il file manca e la storia demo viene riseminata.

**Prima della demo, con QVAC reale:**
* Un turno del modello dura circa 11 s (`evals/README.md`), quindi la trattativa dura 1-2 minuti, non i pochi secondi di `QVAC_MOCK=1`. Avviala per prima e, mentre gli agenti parlano, mostra il resto (Vault, gate): la trattativa prosegue nel backend anche se il pannello cambia vista, e `move_to_vault` funziona anche durante una trattativa, purché nel wallet resti il tetto del compratore (§6).
* Crea e finanzia prima il Vault di Wallet A con `vault/scripts/prefund.mjs` (`vault/README.md`, Demo prep): dal vivo basta sbloccarlo.
* Prima di firmare accendi "Details" nella trattativa: solo così il regolamento elenca i 7 passi rgb-lib.
* Se hai lanciato il contract check senza `--e2e`, azzera la memoria (sopra): ogni run toglie il 10% al punteggio di Wallet A (§3).
* Cronometra una prova completa con QVAC reale.

---

## 5. Dettagli Architetturali Chiave

1. **Controlli prima dello swap (`_ensure_isolated_allocation`)**:
   Maker = seller (Wallet B, dà PEPE), taker = buyer (Wallet A, paga USDT); i ruoli vengono dalla sessione. Prima dello step 1, `execute_atomic_swap` in `backend/rgb_swap_engine.py` controlla che entrambi abbiano il saldo spendibile della propria gamba. Poi `_ensure_isolated_allocation` simula la selezione degli input di rgb-lib per ciascuna gamba: gli input scelti devono contenere esattamente `payment_amount` (taker) e `rgb_amount` (maker), perché la transizione dello swap non ha output di resto RGB. Se non è così crea l'allocazione esatta con un self-send seguito da mining, e se resta impossibile rifiuta il settlement prima di qualsiasi trasferimento. Senza questo lo step 5 del maker fallisce con `InvalidConsignment` (gamba del taker) o il surplus del venditore viene distrutto (lotto parziale).
2. **Doppia firma 2/2 e `terms_hash`**:
   `terms_hash` è lo SHA-256 del JSON di `CanonicalSwapTerms` (`sort_keys=True`, separatori `(",", ":")`), con scadenza a 600 s. Ogni parte invia `POST /api/sessions/{id}/sign` con `{wallet_id, terms_hash}`; la firma è una conferma registrata dal backend, non una firma crittografica. Un hash diverso da quello attivo dà `409 terms_hash_mismatch`; gli altri rifiuti sono `409 already_signed`, `expired`, `not_awaiting_signatures` e `403 forbidden` per un wallet esterno. Solo con entrambe le firme la sessione passa a `SETTLING` e lo swap parte in background (un solo worker); `execute_atomic_swap` ricontrolla le due firme e l'hash ricalcolato dai termini prima di toccare i wallet. Il `txid` è visibile dallo step 6; se qualcosa fallisce dopo il broadcast la sessione va in `FAILED` ma conserva il `txid`.
3. **Valutazione `total_usd`**:
   BTC a `sats_per_usd` (1.000 sats = 1 USD) + USDT (peg a 1,00) + PEPE al prezzo dell'ultimo swap regolato (`agreed_price_usd / rgb_amount`). Prima del primo swap il prezzo PEPE è `null` e PEPE vale 0. La stessa formula vale per ogni punto di `history_points`. Il cambio è uno solo, `SATS_PER_USD` (default 1.000): `market_manager.sats_per_usd` lo legge da `settings`, e lo usano sia `/api/market` sia ogni `total_usd`.
4. **Error handling**:
   Gli errori di validazione Pydantic (il 422 di FastAPI) sono mappati a HTTP 400 con body `{"code": "invalid_request", "message": "<campo>: <errore>"}`. Tutte le altre risposte di errore usano lo stesso formato `{code, message}` e le eccezioni non gestite diventano `500 internal_server_error`.
5. **Indirizzi allineati a Tether WDK**:
   Con `vanilla_keychain=0` il ramo vanilla è `m/84'/1'/0'/0/*`, quindi il primo indirizzo restituito per un wallet nuovo è `m/84'/1'/0'/0/0`, lo stesso che Tether WDK deriva nel browser dalla stessa mnemonic (`POST /api/wallets/create`). `get_address()` di rgb-lib avanza di un indice a ogni chiamata, anche tra un riavvio e l'altro. Il backend lo memorizza per processo, quindi dopo un riavvio i wallet seed mostrano l'indirizzo successivo dello stesso wallet.
6. **Stato su disco e in memoria**:
   Su disco ci sono i wallet rgb-lib in `$MWM_DATA_DIR` (le mnemonic sono in chiaro in `keys.json`, con permessi 0600: solo regtest) e il memory graph in `$MWM_DATA_DIR/memory_graph.json` (§5.11). Sessioni, richieste dello Shop, profili agente, alias, activity, history e prezzo PEPE vivono in memoria e si azzerano a ogni riavvio.
7. **Trattativa e coda**:
   Prima di far parlare gli agenti il backend controlla che un accordo sia possibile: se il massimo del compratore è sotto la riserva del venditore la sessione nasce `BLOCKED_BY_GATE` (`No deal possible: ...`) senza chiamare QVAC e senza rivelare i numeri; anche la ricerca con l'agente salta quei desk. Il prezzo richiesto del desk è il listino pubblico: l'agente del venditore lo difende, quello del compratore lo lavora al ribasso; la riserva non può superare il listino (`400 invalid_profile`). La strategia del proprietario (`strategy_of`: i preset dell'interfaccia iniziano con `Strict:` o `Flexible:`, Balanced è `""`; un testo libero vale Balanced, salvo parole chiare come aggressive, lowball, tough, hard bargain per Strict o quick, fast, close soon per Flexible) decide l'apertura del compratore e il passo minimo. Al round 1 il compratore offre al massimo il 70% (Strict), il 90% (Balanced) o il 95% (Flexible) del suo target (`opening_bid`: arrotondato, almeno 1 USD, sotto il tetto): il codice lo garantisce e il prompt gli indica quel numero, che resta privato. Il rationality guard fa convergere le offerte: ogni nuova offerta si muove verso l'altra parte di almeno max(1 USD, 7% del divario) con Strict, max(2 USD, 15%) con Balanced e max(2 USD, 25%) con Flexible, per il compratore come per il venditore, che apre al listino; anche i passi suggeriti dal prompt seguono la strategia. Prima degli ultimi due round un agente non accetta un prezzo lontano dalla propria ultima offerta ma contropropone un quarto del divario. `ACCEPT` vale solo se il prezzo della controparte è dentro il proprio limite segreto; altrimenti è un'offerta al prezzo del modello e passa gli stessi controlli. Prima degli ultimi due round ogni agente concede a un ritmo segreto, proprio della sessione e del ruolo (`concession_pace`: HMAC dell'id di sessione con una chiave casuale del processo): una linea di tenuta sta a un margine segreto dentro il limite (da 1 USD al 3% del limite, almeno 2 USD) e ogni offerta copre al massimo una quota segreta (25-50%) della distanza rimasta fino a quella linea, per difetto; il tetto vince sul passo minimo a ogni strategia. Così nessuna offerta tocca il limite, e chi conosce le regole non lo ricava dai prezzi: la linea di tenuta lo colloca solo entro il margine. Alla linea di tenuta un agente accetta un prezzo dentro il limite; se la controparte ripete un prezzo oltre il limite (è ferma anche lei), i limiti si sovrappongono meno dei due margini e l'agente offre il limite, l'unico prezzo che chiude, invece di bloccare la trattativa: l'accordo segue a quel prezzo. Negli ultimi due round il limite si può offrire, e l'ultimo round non perde un accordo possibile: il compratore accetta una richiesta entro il tetto o offre il tetto, il venditore accetta un'offerta pari o superiore alla riserva. Il leak guard normalizza il testo (forme Unicode, caratteri invisibili, trattini) e trova il limite in cifre in ogni formato, anche cifra per cifra (`135USDT`, `$135`, `135.00`, `1,350`, `1'350`, `1 3 5`, `1-3-5`), in parole inglesi anche mescolate a cifre (`one hundred and thirty-five`, `one thirty-five`, `one hundred 35`, `thirteen fifty`), con scale e aritmetica semplice (`1.35k`, `13,500 cents`, `150 minus 15`, `a buck under 136`), come numero entro il 5% con linguaggio da limite (`can't go below`, `up to`, `the lowest I'll go`, `not a penny more`), e in ogni frase in cui l'agente parla del proprio limite (my/our reserve, limit, maximum, minimum, floor, ceiling, cap, budget, target, bottom line), anche senza numero. Non legge numeri romani, altre basi, liste attaccate che si leggono come migliaia (`125,135`) né aritmetica più lunga. Se il leak guard scatta, se il rationality guard cambia azione o prezzo, o se le parole contraddicono la mossa (un `ACCEPT` che non accetta, un'offerta che dice di accettare), il messaggio pubblico è una frase neutra costruita dall'azione e dall'offerta finali (alcune per ruolo e azione, con aperture proprie nel round 1, nessuna in comune tra i ruoli, scelte in modo riproducibile da sessione, ruolo e round) che non cita altri numeri: le parole del modello restano solo se niente è cambiato. Ogni agente legge solo le regole del proprio ruolo: il compratore non vede quelle del venditore, il venditore nessun target del compratore. I round proseguono fino all'accordo, con un tetto di sicurezza (`NEGOTIATION_MAX_ROUNDS`, default 10). La trattativa si chiude prima, senza accordo, se nessuna delle due parti si muove per due round (`No agreement: the offers stopped moving.`). Le trattative entrano in una coda in ordine di arrivo (`backend/negotiation_queue.py`), una alla volta perché QVAC serve un solo modello locale: chi aspetta resta `NEGOTIATING` senza round, con `queue_position` nella `SessionView`. `GET /api/negotiations/queue` elenca le trattative in corso e in attesa. Quando arriva il suo turno, se il venditore non ha più il lotto la sessione va in `BLOCKED_BY_GATE`.
8. **Lotti parziali e strategie**:
   Se il venditore lo consente (`allow_partial` nel profilo, spento per default; Wallet B, il venditore della demo, parte con il consenso già attivo, perché i profili vivono in RAM e si azzerano a ogni riavvio) il compratore può prendere una parte del lotto di un desk, da quella che vale 10 USDT al listino (`MIN_PART_USD`, `ceil(offered_amount * 10 / asking_price_usd)`; un lotto che vale meno di 10 USDT si vende solo intero) fino al lotto intero, così gli agenti hanno margine per trattare in dollari interi (i prezzi sono interi: l'USDT della demo ha 0 decimali): listino e riserva della sessione sono quelli del desk in proporzione alla quantità (stessi prezzi unitari; il listino arrotonda a metà, la riserva per eccesso). Senza consenso si compra solo il lotto intero (`409 partial_not_allowed`), e la ricerca con l'agente salta quel desk per una quantità parziale. Fuori da questi limiti: `409 exceeds_lot` e `400 amount_too_small`. Dopo una vendita il lotto del desk si riduce della quantità venduta a parità di prezzi unitari; esaurito, il desk si spegne. La strategia di ciascun proprietario (`buyer_ai_prompt`, `seller_ai_prompt`) arriva al suo agente come istruzione; Balanced è il comportamento di default e corrisponde a `""`.
9. **Isolamento delle allocazioni nello swap**:
   La patch di swap di rgb-lib prende gli input RGB a UTXO intere, dalla più piccola, senza resto RGB, e paga l'output RGB ricevuto (più la fee di rete per il taker, 3.000 sats in tutto) solo con i BTC di quegli input. Prima dello swap ogni parte rimanda a sé tutto il saldo dell'asset in due pezzi: la quantità esatta su un output nuovo da 10.000 sats (witness receive) e il resto su una blind receive senza asset ID, che un refresh filtrato sull'asset lascia pending fino a dopo lo swap. Il taker ritrasmette la transazione di swap già trasmessa dal maker, così il suo database segna come spesi i propri input. Verificato su regtest con cinque swap parziali concatenati tra Wallet A e B.
10. **Shop**:
   Le vendite (`sell`) sono i Seller Desk attivi, costruiti al volo dai profili agente con i soli campi pubblici; le richieste (`want`) stanno in `backend/shop.py`. `POST /api/shop/agent_search` sceglie il desk più conveniente per la quantità richiesta, scarta i desk non affidabili (ring, `Low Reliability`, `Unverified`: la ricerca automatica non sceglie mai un rischio) e quelli sopra 1,5 volte il tetto del compratore, poi crea la sessione con la stessa logica di `POST /api/sessions` (stesso gate, stessi errori).
11. **Memory graph e punteggio di affidabilità (`backend/memory_graph.py`)**:
   Ogni swap regolato (`SETTLED`) viene ricordato nei due versi in `$MWM_DATA_DIR/memory_graph.json`: scrittura atomica (file temporaneo + `os.replace`), caricato all'avvio. Se il file manca viene seminata la storia demo, dichiarata nel README: circa un mese di scambi per Wallet A e Wallet B con cinque peer indipendenti (che hanno una storia loro), un nuovo trader con un solo scambio, e Sybil in un anello di wash trading. I peer e i nodi dell'anello (`node_*`) non hanno indirizzo e non compaiono mai tra i contatti. Un file illeggibile viene rinominato `memory_graph.json.unreadable-<ts>` e la storia demo riseminata.
   Il punteggio lo calcola il codice, mai l'AI, dagli scambi regolati di ogni wallet: `100 × (0,35 attività + 0,25 varietà + 0,25 qualità + 0,15 anzianità) × (1 − penalità)`, arrotondato e limitato a 1..99. Attività `1 − e^(−n/6)` con n scambi; varietà `min(k/5, 1)` con k controparti distinte; qualità = media dell'affidabilità delle controparti (punteggio/100 se `High Authenticity`, 0,3 se `Unverified`, 0 se `Low Reliability` o ring), calcolata un solo livello in profondità: ogni controparte è valutata con la stessa formula senza il proprio termine di qualità (pesi riscalati a 1), così non c'è ricorsione; anzianità `min(giorni dal primo scambio / 30, 1)`; penalità `min(0,1 × accordi abbandonati, 0,5)`. Un accordo è abbandonato se la sessione era in `AWAITING_SIGNATURES` e quella parte l'ha annullata, oppure non ha firmato prima della scadenza mentre l'altra sì: `session_store` lo registra all'annullamento e quando rileva la scadenza (alla prossima lettura della sessione o della lista, che la UI interroga di continuo), una volta per sessione.
   Livelli: nessuno scambio → `Unverified` (`reliability_pct` null); un anello chiuso (`detect_ring`: un lotto che torna a chi l'ha inviato attraverso almeno altri due wallet, entro 4 passi, con lo stesso asset e una quantità entro il 10% a ogni passo) → `Ring Anomaly Detected`, punteggio al massimo 20; da 60 → `High Authenticity`; sotto → `Low Reliability`. Con la storia seminata Wallet A vale 89, Wallet B 86, Sybil 20; dopo uno swap demo A e B salgono di circa un punto. Nessun livello blocca da solo: un venditore che non è `High Authenticity` (`Low Reliability`, `Unverified` o un ring) richiede il consenso del compratore. Senza `accept_risk: true` `POST /api/sessions` risponde `409 confirm_risk` e non crea nulla (per un ring il messaggio è più forte: `Sybil trades in loops with itself, a pattern used to fake reliability. Trading with it is a high risk.`); con il consenso la sessione registra `risk_accepted: true` e il controllo dopo l'accordo (`evaluate_gate`) la lascia passare. Restano bloccati solo un indirizzo sconosciuto e una coppia senza accordo possibile. Il livello del compratore non blocca mai, così un wallet nuovo o debole può scambiare e ricostruirsi il punteggio; annullare o non firmare un accordo con una controparte non `High Authenticity` non conta come abbandono. Ogni agente riceve nel prompt (e il mock nel pensiero privato) il punteggio e il livello della controparte, per esempio `Counterparty reliability: 86% (High Authenticity), computed from settled trades.`: può essere più prudente con una controparte debole, ma il controllo resta nel codice. Nessun prompt né testo esposto contiene i limiti segreti della controparte o il numero di scambi; `assessment_summary` è un testo generico per livello.

---

## 6. Vault: l'unico invio è verso il proprio Vault

Il Vault è la parte self-custodial dell'account: un servizio Node separato (`vault/`, Tether WDK) con un seed proprio, uno per wallet id, che backend e agenti non vedono mai. Il backend lo chiama su `VAULT_URL`, mai tenendo `SWAP_GLOBAL_LOCK`.

| Endpoint | Cosa fa |
|---|---|
| `POST /api/wallets/{id}/receive_invoice {asset_id, amount}` | Vault → Wallet: invoice di blind receive per il wallet AI, che scade dopo 15 minuti. La chiede il Vault |
| `POST /api/wallets/{id}/refresh` | Due passate di refresh rgb-lib; ogni invoice di `receive_invoice` regolata diventa un'activity `vault` / `in` |
| `POST /api/wallets/{id}/move_to_vault {asset_id, amount}` | Wallet → Vault, risponde `{txid, asset_id, amount}` |

**Eccezione voluta.** A parte lo swap 2/2, `move_to_vault` è l'unico endpoint che invia fondi, e può pagare solo il Vault dello stesso wallet id: l'invoice la chiede il backend a `{VAULT_URL}/vault/{id}/invoice` e non la accetta mai dal client (un campo in più nel body dà `400 invalid_request`). Prima di pagare controlla che l'invoice sia di regtest, valida ancora per almeno un minuto, e che non chieda un altro asset o un'altra quantità (può lasciarli aperti: rgb-lib nomina solo un asset che il wallet ha già avuto, quindi la prima invoice di un Vault non ne nomina nessuno). Poi paga con rgb-lib sotto `SWAP_GLOBAL_LOCK` (donation, 1 sat/vB), mina un blocco, fa refresh e chiede al Vault `POST /vault/{id}/refresh`; se quest'ultima chiamata fallisce resta solo un warning. Dopo il broadcast non risponde mai con un errore, perché un nuovo tentativo pagherebbe due volte.

**Nel wallet resta quello che è già promesso.** Prima di chiedere l'invoice al Vault, quindi prima di qualsiasi invio, `move_to_vault` controlla che dopo lo spostamento nel wallet resti:
* il lotto del Seller Desk attivo su quell'asset, altrimenti `409 desk_lot` (`1000000 PEPE are listed on your Seller Desk. Lower the lot or pause the desk first.`);
* quanto il wallet ha promesso nelle trattative in corso (`NEGOTIATING`, `AWAITING_SIGNATURES`, `SETTLING`), sommando le sessioni: da venditore il lotto della sessione, da compratore il prezzo concordato oppure, finché si tratta, il proprio tetto segreto, che il prezzo può ancora raggiungere. Altrimenti `409 funds_committed` (`135 USDT are promised in a deal in progress. Wait for it to finish or cancel it.`).

Il messaggio lo vede solo il proprietario del wallet e contiene solo importi suoi: il proprio tetto sì, mai la riserva o il tetto della controparte. Le quantità sono in cifre senza separatori, come negli altri messaggi del backend.

Errori `{code, message}`: `400 invalid_request` (asset diverso da USDT/PEPE, quantità non intera o ≤ 0), `404 wallet_not_found`, `409 insufficient_funds`, `409 desk_lot`, `409 funds_committed`, `409 vault_missing` / `vault_locked`, `503 vault_unavailable`, `502 vault_invoice_mismatch` (nessun invio), `500 move_failed`; gli altri 4xx del Vault passerebbero con il loro codice, ma non se ne aspettano: la route `invoice` del Vault non invia nulla, quindi la sua policy di invio non entra mai in gioco (niente `403 policy_denied`). `receive_invoice` e `refresh` danno `503 wallet_unavailable` se rgb-lib o l'indexer non rispondono.

**Agenti ciechi sul Vault.** Nessun dato del Vault arriva al negoziatore, i movimenti non creano archi nel memory graph e il backend non conserva saldi del Vault: ogni movimento lascia solo un'activity `kind: "vault"` (`out` = verso il Vault, `in` = dal Vault, `counterparty_address: null`) e un punto in `history_points`. La blind receive usa una UTXO colorabile vuota (`WalletManager.ensure_free_utxos`), quindi non tocca mai la UTXO del lotto che uno swap seleziona.

Test ermetici in `backend/tests/test_vault_link.py`. E2E reale su regtest, con un wallet rgb_lib Python come Vault sostitutivo dietro uno stub HTTP, contro un backend di test avviato con `VAULT_URL=http://127.0.0.1:8202`:
```bash
.venv/bin/python scripts/e2e_vault_link.py --backend http://127.0.0.1:8101 --vault-port 8202
```
Lo script non parte se la porta è già occupata (per esempio dal vero servizio Vault). Esito atteso: `RESULT: PASS (13/13 checks)`. Per PEPE: `--wallet wallet_b --asset PEPE --amount 250000`, dopo aver abbassato a 750.000 il lotto del desk di Wallet B o averlo messo in pausa (altrimenti `409 desk_lot`).
