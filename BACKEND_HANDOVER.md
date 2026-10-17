# MwM Backend Handover & Run Guide

Guida operativa completa per avviare, configurare e testare il backend di Money with Memory (MwM) su una nuova macchina.

---

## 1. Architettura & Requisiti

Il backend orchestra:
* **Bitcoin Regtest + Electrs + RGB Proxy** (gestiti via Docker Compose)
* **`rgb-lib` (v0.3.0b7)**: Motore nativo per emissione, trasferimenti e atomic swap RGB peer-to-peer (NIA).
* **QVAC Local Inference**: Agente LLM negoziatore autonomo (`buyer-agent` su porta 11435).
* **FastAPI Server**: Espone le API REST per wallet, contratti, memoria e sessioni di negoziazione.

### Prerequisiti
* macOS o Linux (Apple Silicon o x86_64)
* **Docker** o **OrbStack** attivo
* **Python ≥ 3.11**
* **Node.js ≥ 22** (per eseguire gli script di verifica del contratto)
* **QVAC** con modello `buyer-agent`

---

## 2. Setup Passo-Passo

### Passo 1: Avviare i servizi Docker (Regtest, Electrs, Proxy)
Dalla root del repository:
```bash
docker compose up -d
```
Verifica che i tre container siano operativi (`docker ps`):
* `mwm-bitcoind-1` su `18443`
* `mwm-electrs-1` su `50001`
* `mwm-proxy-1` su `3000`

### Passo 2: Creare l'ambiente virtuale Python & Installare le Dipendenze
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Passo 3: Inizializzare lo Stato e gli Asset Demo (Seed)
Il comando seed si connette a regtest, Electrum e al proxy, crea le directory in `~/.mwm/data/`, finanzia Wallet A e Wallet B con BTC regtest, genera le UTXO per RGB ed emette i due token demo (1.000.000 PEPE su Wallet B e 10.000 USDT su Wallet A):
```bash
PYTHONPATH=. python backend/seed.py
```

### Passo 4: Avviare il Server FastAPI
Se QVAC è in esecuzione sulla stessa macchina (es. Mac di Safet):
```bash
QVAC_BASE_URL=http://127.0.0.1:11435/v1 \
QVAC_MODEL=buyer-agent \
uvicorn backend.api_server:app --host 0.0.0.0 --port 8000
```
Se QVAC richiede autenticazione tramite chiave:
```bash
QVAC_BASE_URL=http://127.0.0.1:11435/v1 \
QVAC_MODEL=buyer-agent \
QVAC_API_KEY="<LA_TUA_CHIAVE>" \
uvicorn backend.api_server:app --host 0.0.0.0 --port 8000
```

Verifica che il server risponda:
```bash
curl -s http://127.0.0.1:8000/api/health
# Output atteso: {"regtest":true,"qvac":true,"proxy":true}
```

---

## 3. Test e Verifica di Conformità

### Test Unitari Backend
Esegui la suite completa (26 test, copre router, contratti, gate e atomic swap):
```bash
.venv/bin/pytest backend/tests/
```

### Contract-Check Script (Frontend → Backend)
Per testare la conformità del contratto API dal terminale:
```bash
node --experimental-strip-types frontend/scripts/contract-check.mjs http://127.0.0.1:8000
```

### E2E con Negoziazione Live & Atomic Swap On-Chain
Per simulare il flusso completo (negoziazione AI tra agenti, doppia firma delle parti, blocco mining e regolamento RGB a 7 step):
```bash
node --experimental-strip-types frontend/scripts/contract-check.mjs http://127.0.0.1:8000 --e2e
```
*Esito atteso*: `OK: 0 failed, 0 warnings` con transazione broadcastata e confermata (`SETTLED in ~7.5s`).

---

## 4. Dettagli Architetturali Chiave

1. **Atomic Swap Step 5 (`_ensure_isolated_allocation`)**:
   `rgb-lib` richiede che il Taker abbia una UTXO con l'importo esatto di USDT dedicato prima di completare la proposta di swap. `_ensure_isolated_allocation` in `backend/rgb_swap_engine.py` gestisce questo passaggio in automatico tramite un self-transfer con mining prima dello Step 1.
2. **Doppia Firma 2/2 e `terms_hash`**:
   Lo swap parte in background solo quando sia Buyer che Seller hanno inviato `POST /api/sessions/{id}/sign` con lo SHA-256 esatto dei termini canonici concordati.
3. **Valutazione `total_usd`**:
   `total_usd` include il controvalore BTC a `sats_per_usd` (1.000 sats = 1 USD) + USDT (peggato a 1.00) + PEPE valorizzato al prezzo unitario dell'ultimo swap concordato ($\text{agreed} / \text{lot}$).
4. **Error Handling**:
   Gli errori di validazione Pydantic 422 sono mappati globalmente a HTTP 400 con body `{"code": "invalid_request", "message": "..."}` per conformità con il frontend.
