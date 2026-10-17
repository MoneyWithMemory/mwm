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
* **Node.js ≥ 23.6**: serve solo per il contract check (verificato con Node 26).
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
| `QVAC_BASE_URL` | IP di LAN usato in sviluppo | **Impostala sempre**: `http://127.0.0.1:11435/v1` se QVAC gira sulla stessa macchina, altrimenti `http://<IP_HOST_QVAC>:11435/v1` |
| `QVAC_API_KEY` | vuota | Se è vuota il backend legge `~/.mwm/qvac.key` (una riga). Non committarla mai |
| `QVAC_MODEL` | `buyer-agent` | Nome del modello in `qvac.config.json` |
| `QVAC_MOCK` | `0` | `1` = negoziatore mock deterministico senza chiamate a QVAC (`/api/health` riporta `qvac: true`) |
| `MWM_DATA_DIR` | `~/.mwm/data` | Wallet rgb-lib: `<wallet_id>/keys.json` + database |
| `ELECTRUM_URL`, `PROXY_URL` | `127.0.0.1:50001`, `http://127.0.0.1:3000/json-rpc` | Servizi del Passo 1 |

Se QVAC non risponde durante una negoziazione, il backend passa al mock senza errori per il frontend: resta solo un warning nei log (`QVAC live call failed ... Falling back to internal mock`).

### Passo 4: Avviare il server FastAPI
Regtest deve essere già attivo. In un terminale dedicato:
```bash
QVAC_BASE_URL=http://127.0.0.1:11435/v1 \
.venv/bin/uvicorn backend.api_server:app --host 0.0.0.0 --port 8000
```
Senza QVAC metti `QVAC_MOCK=1` al posto di `QVAC_BASE_URL=...`.

All'avvio (lifespan → `RgbSwapEngine.setup_demo_environment`) il backend prepara da solo la demo. `backend/seed.py` contiene solo i parametri dei wallet seed e non va eseguito.
* Finanzia Wallet A e Wallet B con `initial_btc_sats` di `backend/seed.py` (1.000.000 sats = 0,01 BTC ciascuno) e crea su entrambi 5 UTXO colorabili da 10.000 sats.
* Emette 1.000.000 PEPE su Wallet B (se B non ne ha già almeno 1.000.000) e 10.000 USDT su Wallet A (se A non ne ha già almeno 10.000 spendibili).

Nei log compare `Demo environment ready: PEPE=... USDT=...`. Finanziamento e UTXO si ripetono a ogni avvio.

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
`pytest.ini` imposta `pythonpath = .` e `testpaths = backend/tests`. Sono 26 test su API, gate e trust, guardie del negoziatore, macchina a stati delle sessioni e controlli 2/2 dello swap; lo swap on-chain reale si verifica solo con `--e2e`. Regtest e QVAC non devono essere attivi, ma `rgb_lib` deve essere nel venv. La suite è ermetica: `backend/tests/conftest.py` usa un `MWM_DATA_DIR` temporaneo e `QVAC_MOCK=1` di default (con `QVAC_MOCK=0` usa QVAC reale), quindi non tocca i wallet reali e non chiama QVAC.

### Contract check (frontend → backend)
Lo script sta in `frontend/`, che non è su `feat/backend-core`: è su `feat/frontend-wdk` (e su `main` dopo il merge). Importa solo `src/api/types.ts` e `src/api/mock/sha256.ts`, quindi non serve `npm install`.

Prima del merge, estrai i file necessari in `/tmp`:
```bash
git fetch origin
rm -rf /tmp/mwm-check && mkdir -p /tmp/mwm-check
git archive origin/feat/frontend-wdk frontend/scripts frontend/src/api frontend/package.json | tar -x -C /tmp/mwm-check
(cd /tmp/mwm-check/frontend && node --experimental-strip-types scripts/contract-check.mjs http://127.0.0.1:8000)
```
Dopo il merge su `main`: `node --experimental-strip-types frontend/scripts/contract-check.mjs http://127.0.0.1:8000`.

*Esito atteso*: `OK: 0 failed, 0 warnings` in circa 60 s con negoziazione QVAC reale. Senza `--e2e` lo script crea solo due sessioni brevi (una bloccata dal gate, una annullata) e non sposta fondi. Se gli agenti non trovano un accordo compare un `WARN` e i controlli di firma vengono saltati: rilancia lo script.

### E2E con negoziazione live e atomic swap on-chain
Negoziazione AI, doppia firma delle parti e regolamento RGB a 7 step su regtest:
```bash
(cd /tmp/mwm-check/frontend && node --experimental-strip-types scripts/contract-check.mjs http://127.0.0.1:8000 --e2e)
```
*Esito atteso*: `OK: 0 failed, 0 warnings`, con `SETTLED in ~7.5s` dopo la seconda firma. Lo swap sposta l'intero lotto di 1.000.000 PEPE da Wallet B a Wallet A e gli USDT concordati da A a B. Per rilanciare `--e2e` serve prima il reset (§4).

---

## 4. Reset dello stato demo

Dopo un `--e2e` Wallet B non ha più PEPE (sono passati a Wallet A) e Wallet A ha meno di 10.000 USDT. Se riavvii il server senza reset, `setup_demo_environment` emette nuovi PEPE e USDT con nuovi asset id: i saldi restano divisi tra asset vecchi e nuovi e l'API mostra solo quelli nuovi. Un riavvio senza swap invece riusa gli stessi asset.

Per ripartire da zero:
```bash
# 1. ferma il server (Ctrl+C nel terminale di uvicorn)
./scripts/regtest.sh reset
rm -rf "${MWM_DATA_DIR:-$HOME/.mwm/data}"
./scripts/regtest.sh start
# 4. riavvia il server (Passo 4)
```
* `reset` cancella container e volumi (chain nuova). Cancella sempre anche il data dir, perché i wallet che contiene fanno riferimento alla chain precedente. `~/.mwm/qvac.key` non viene toccato.
* Al riavvio il backend crea wallet nuovi (nuove mnemonic e nuovi indirizzi), li finanzia ed emette gli asset demo.
* Il reset è **obbligatorio una volta** dopo il pull della modifica `vanilla_keychain=0`: un data dir creato con keychain 1 non si riapre (errore rgb-lib `Descriptor mismatch`).

---

## 5. Dettagli Architetturali Chiave

1. **Atomic swap step 5 (`_ensure_isolated_allocation`)**:
   Maker = seller (Wallet B, dà PEPE), taker = buyer (Wallet A, paga USDT); i ruoli vengono dalla sessione. Prima dello step 1, `_ensure_isolated_allocation` in `backend/rgb_swap_engine.py` controlla che il taker abbia una UTXO con un'unica allocazione settled di esattamente `payment_amount`; se non c'è la crea con un self-send seguito da mining. Senza questo passaggio lo step 5 (`process_swap_completion` del maker) fallisce con `InvalidConsignment`.
2. **Doppia firma 2/2 e `terms_hash`**:
   `terms_hash` è lo SHA-256 del JSON di `CanonicalSwapTerms` (`sort_keys=True`, separatori `(",", ":")`), con scadenza a 600 s. Ogni parte invia `POST /api/sessions/{id}/sign` con `{wallet_id, terms_hash}`; la firma è una conferma registrata dal backend, non una firma crittografica. Un hash diverso da quello attivo dà `409 terms_hash_mismatch`; gli altri rifiuti sono `409 already_signed`, `expired`, `not_awaiting_signatures` e `403 forbidden` per un wallet esterno. Solo con entrambe le firme la sessione passa a `SETTLING` e lo swap parte in background; `execute_atomic_swap` ricontrolla le due firme e l'hash ricalcolato dai termini prima di toccare i wallet.
3. **Valutazione `total_usd`**:
   BTC a `sats_per_usd` (1.000 sats = 1 USD) + USDT (peg a 1,00) + PEPE al prezzo dell'ultimo swap regolato (`agreed_price_usd / rgb_amount`). Prima del primo swap il prezzo PEPE è `null` e PEPE vale 0. La stessa formula vale per ogni punto di `history_points`.
4. **Error handling**:
   Gli errori di validazione Pydantic (il 422 di FastAPI) sono mappati a HTTP 400 con body `{"code": "invalid_request", "message": "<campo>: <errore>"}`. Tutte le altre risposte di errore usano lo stesso formato `{code, message}` e le eccezioni non gestite diventano `500 internal_server_error`.
5. **Indirizzi allineati a Tether WDK**:
   Con `vanilla_keychain=0` il ramo vanilla è `m/84'/1'/0'/0/*`, quindi il primo indirizzo restituito per un wallet nuovo è `m/84'/1'/0'/0/0`, lo stesso che Tether WDK deriva nel browser dalla stessa mnemonic (`POST /api/wallets/create`). `get_address()` di rgb-lib avanza di un indice a ogni chiamata, anche tra un riavvio e l'altro. Il backend lo memorizza per processo, quindi dopo un riavvio i wallet seed mostrano l'indirizzo successivo dello stesso wallet.
6. **Stato su disco e in memoria**:
   Su disco ci sono solo i wallet rgb-lib in `$MWM_DATA_DIR` (le mnemonic sono in chiaro in `keys.json`: solo regtest). Sessioni, profili agente, alias, activity, history, memory graph e prezzo PEPE vivono in memoria e si azzerano a ogni riavvio.
