#!/usr/bin/env bash
# MwM demo reset: one command for a clean demo state, backend restarted in the background.
# Usage:
#   scripts/demo_reset.sh             full reset: new regtest chain, wallet data deleted, new asset ids
#   scripts/demo_reset.sh --restart   backend restart only: keeps chain and wallets (after a swap
#                                     the setup issues new PEPE/USDT)
# Env: MWM_DATA_DIR, MWM_LOG (default ~/.mwm/logs/backend.log), API_PORT, and the QVAC_* variables
# of backend/config.py, passed through to the backend.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=full
case "${1:-}" in
    ""|--full) MODE=full ;;
    --restart) MODE=restart ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

PORT="${API_PORT:-8000}"
DATA_DIR="${MWM_DATA_DIR:-$HOME/.mwm/data}"
LOG="${MWM_LOG:-$HOME/.mwm/logs/backend.log}"
UVICORN="$ROOT/.venv/bin/uvicorn"
PYTHON="$ROOT/.venv/bin/python"
API="http://127.0.0.1:${PORT}"

_die() { echo "ERR: $*" >&2; exit 1; }

[ -x "$UVICORN" ] || _die "missing $UVICORN: create the venv first (BACKEND_HANDOVER.md, Passo 2)"

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

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
echo
echo "health: $(curl -s -m 10 "$API/api/health")"
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
Watch:     .venv/bin/python scripts/watch_demo.py
Log:       tail -f $LOG
Stop:      kill \$(lsof -tiTCP:${PORT} -sTCP:LISTEN)
EOF
