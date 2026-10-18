#!/usr/bin/env bash
# MwM demo reset: one command for a clean demo state, backend restarted in the background.
# Usage:
#   scripts/demo_reset.sh             full reset: new regtest chain, wallet data deleted, new asset ids
#   scripts/demo_reset.sh --restart   backend restart only: keeps chain, wallets and the trust memory;
#                                     the demo assets are reused (a new PEPE lot only if Wallet B holds none)
# Env: MWM_DATA_DIR, MWM_LOG (default ~/.mwm/logs/backend.log), API_PORT, and the QVAC_* variables
# of backend/config.py, passed through to the backend.
# Vault (vault/, restarted after the backend; its Vaults come back locked): VAULT_PORT (8200),
# MWM_VAULT_DIR (~/.mwm/vault, deleted by a full reset), MWM_VAULT_LOG (~/.mwm/logs/vault.log),
# VAULT_NODE (a Node 22 binary; found automatically when unset).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=full
case "${1:-}" in
    ""|--full) MODE=full ;;
    --restart) MODE=restart ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

PORT="${API_PORT:-8000}"
DATA_DIR="${MWM_DATA_DIR:-$HOME/.mwm/data}"
LOG="${MWM_LOG:-$HOME/.mwm/logs/backend.log}"
UVICORN="$ROOT/.venv/bin/uvicorn"
PYTHON="$ROOT/.venv/bin/python"
API="http://127.0.0.1:${PORT}"

VAULT_PORT="${VAULT_PORT:-8200}"
VAULT_DIR="${MWM_VAULT_DIR:-$HOME/.mwm/vault}"
VAULT_LOG="${MWM_VAULT_LOG:-$HOME/.mwm/logs/vault.log}"
VAULT_MAIN="$ROOT/vault/src/main.js"
VAULT_API="http://127.0.0.1:${VAULT_PORT}"
# The backend calls the Vault for Wallet -> Vault moves.
export VAULT_URL="${VAULT_URL:-$VAULT_API}"

_die() { echo "ERR: $*" >&2; exit 1; }

[ -x "$UVICORN" ] || _die "missing $UVICORN: create the venv first (BACKEND_HANDOVER.md, Passo 2)"

# The Vault's native rgb-lib binding builds on Node 22, not on Node 24+ (vault/README.md).
vault_node() {
    local candidate
    for candidate in "${VAULT_NODE:-}" "$HOME/.mwm/node22/bin/node" /opt/homebrew/opt/node@22/bin/node \
        /usr/local/opt/node@22/bin/node "$(command -v node || true)"; do
        [ -n "$candidate" ] && [ -x "$candidate" ] || continue
        if [ "$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 22 ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

stop_vault() {
    local pids pid cmdline cwd
    pids=$(lsof -tiTCP:"$VAULT_PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$pids" ] && return 0
    for pid in $pids; do
        # Only ever stop our own Vault service (started here, or by `npm start` in vault/): anything else
        # on the port is left alone.
        cmdline=$(ps -o command= -p "$pid")
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
        if [[ "$cmdline" == *"$VAULT_MAIN"* ]] || { [[ "$cmdline" == *" src/main.js"* ]] && [ "$cwd" = "$ROOT/vault" ]; }; then
            echo "stopping Vault (pid $pid)"
            kill "$pid"
        else
            _die "port $VAULT_PORT is used by another program (pid $pid): $cmdline"
        fi
    done
    for _ in $(seq 1 30); do
        lsof -tiTCP:"$VAULT_PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
        sleep 0.5
    done
    _die "Vault did not stop within 15 s"
}

# Best effort: a demo without the Vault still runs, so a missing Node 22 or install only warns.
start_vault() {
    local node pid
    if ! node=$(vault_node); then
        echo "WARN: Vault not started: no Node 22 found (set VAULT_NODE, see vault/README.md)" >&2
        return 0
    fi
    if [ ! -d "$ROOT/vault/node_modules" ]; then
        echo "WARN: Vault not started: run (cd vault && PATH=$(dirname "$node"):\$PATH npm ci) first" >&2
        return 0
    fi
    mkdir -p "$(dirname "$VAULT_LOG")"
    echo "===== $(date '+%F %T') demo_reset ($MODE) =====" >> "$VAULT_LOG"
    VAULT_PORT="$VAULT_PORT" MWM_VAULT_DIR="$VAULT_DIR" BACKEND_URL="$API" \
        nohup "$node" "$VAULT_MAIN" >> "$VAULT_LOG" 2>&1 < /dev/null &
    pid=$!
    echo "Vault starting (pid $pid), log: $VAULT_LOG"
    for _ in $(seq 1 30); do
        curl -sf -m 2 "$VAULT_API/vault/health" >/dev/null && return 0
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    echo "WARN: the Vault did not come up (see $VAULT_LOG)" >&2
}

stop_vault

stop_backend() {
    local pids pid
    pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$pids" ] && return 0
    for pid in $pids; do
        # Only ever stop our own backend: anything else on the port is left alone.
        if ps -o command= -p "$pid" | grep -q "uvicorn backend.api_server:app"; then
            echo "stopping backend (pid $pid)"
            kill "$pid"
        else
            _die "port $PORT is used by another program (pid $pid): $(ps -o command= -p "$pid")"
        fi
    done
    for _ in $(seq 1 30); do
        lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
        sleep 0.5
    done
    _die "backend did not stop within 15 s"
}

stop_backend

if [ "$MODE" = full ]; then
    case "$DATA_DIR" in
        ""|"/"|"$HOME"|"$HOME/") _die "refusing to delete MWM_DATA_DIR=$DATA_DIR" ;;
    esac
    echo "resetting regtest (new chain)..."
    ./scripts/regtest.sh reset
    echo "deleting wallet data in $DATA_DIR"
    rm -rf "$DATA_DIR"
    # Vault wallets live on the old chain too.
    case "$VAULT_DIR" in
        ""|"/"|"$HOME"|"$HOME/") _die "refusing to delete MWM_VAULT_DIR=$VAULT_DIR" ;;
    esac
    echo "deleting Vault data in $VAULT_DIR"
    rm -rf "$VAULT_DIR"
fi
./scripts/regtest.sh start

mkdir -p "$(dirname "$LOG")"
echo "===== $(date '+%F %T') demo_reset ($MODE) =====" >> "$LOG"
offset=$(wc -c < "$LOG" | tr -d ' ')
nohup "$UVICORN" backend.api_server:app --host 0.0.0.0 --port "$PORT" >> "$LOG" 2>&1 < /dev/null &
pid=$!
echo "backend starting (pid $pid), log: $LOG"

ready=""
for _ in $(seq 1 240); do
    new_lines=$(tail -c +"$((offset + 1))" "$LOG")
    if grep -q "Demo environment ready" <<< "$new_lines"; then ready=1; break; fi
    if grep -qE "setup deferred|Traceback|Application startup failed|address already in use" <<< "$new_lines"; then break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
done
if [ -z "$ready" ]; then
    echo "--- last backend log lines ---" >&2
    tail -c +"$((offset + 1))" "$LOG" | tail -n 25 >&2
    _die "the demo setup did not complete (see $LOG)"
fi

start_vault

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo
echo "health: $(curl -s -m 10 "$API/api/health")"
echo "vault:  $(curl -s -m 5 "$VAULT_API/vault/health" || echo 'not running')"
"$PYTHON" - "$API" <<'PY'
import json, sys, urllib.request

api = sys.argv[1]
get = lambda path: json.load(urllib.request.urlopen(api + path, timeout=30))
for asset in get("/api/market")["assets"]:
    print(f"{asset['ticker']:<5} {asset['asset_id']}")
for wallet in get("/api/wallets"):
    state = get(f"/api/wallets/{wallet['wallet_id']}")
    balances = ", ".join(f"{a['ticker']} {a['amount']:,}" for a in state["assets"])
    print(f"{wallet['label']:<9} {wallet['address']}  {balances}")
PY
cat <<EOF

Frontend:  VITE_API_MODE=http VITE_API_TARGET=http://${ip:-<this-machine-ip>}:${PORT}
Vault:     VITE_VAULT_TARGET=${VAULT_API} (this machine only: a frontend run elsewhere shows "Vault unavailable")
Watch:     .venv/bin/python scripts/watch_demo.py
Log:       tail -f $LOG
Vault log: tail -f $VAULT_LOG
Stop:      kill \$(lsof -tiTCP:${PORT} -sTCP:LISTEN) \$(lsof -tiTCP:${VAULT_PORT} -sTCP:LISTEN)
EOF
