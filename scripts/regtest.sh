#!/usr/bin/env bash
# MwM regtest helper: works on the repo's compose.yaml (bitcoind, electrs, proxy).
# Usage:
#   scripts/regtest.sh start            # up services, create/load miner wallet, mine 111
#   scripts/regtest.sh stop             # stop services (keeps volumes)
#   scripts/regtest.sh reset            # stop and wipe containers (fresh chain)
#   scripts/regtest.sh mine <blocks>
#   scripts/regtest.sh sendtoaddress <address> <amount_btc>
#   scripts/regtest.sh height
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "${ROOT}/compose.yaml")
BCLI=("${COMPOSE[@]}" exec -T -u blits bitcoind bitcoin-cli -regtest)
TIMEOUT=100

_die() { echo "ERR: $*" >&2; exit 1; }

_wait_for() {
    local service="$1" pattern="$2" start
    start=$(date +%s)
    until "${COMPOSE[@]}" logs "$service" 2>/dev/null | grep -c "$pattern" >/dev/null; do
        (( $(date +%s) - start > TIMEOUT )) && _die "timeout waiting for $service"
        sleep 1
    done
}

_ensure_miner() {
    if ! "${BCLI[@]}" -rpcwallet=miner getwalletinfo >/dev/null 2>&1; then
        "${BCLI[@]}" loadwallet miner >/dev/null 2>&1 || "${BCLI[@]}" createwallet miner >/dev/null
    fi
}

mine() {
    [ -n "${1:-}" ] || _die "blocks required"
    _ensure_miner
    "${BCLI[@]}" -rpcwallet=miner -generate "$1" >/dev/null
}

sendtoaddress() {
    [ -n "${1:-}" ] && [ -n "${2:-}" ] || _die "address and amount required"
    _ensure_miner
    "${BCLI[@]}" -rpcwallet=miner sendtoaddress "$1" "$2"
}

start() {
    "${COMPOSE[@]}" up -d bitcoind proxy
    _wait_for bitcoind 'Bound to'
    "${COMPOSE[@]}" up -d electrs
    _ensure_miner
    local height
    height=$("${BCLI[@]}" getblockcount)
    if (( height < 111 )); then mine $((111 - height)); fi
    _wait_for electrs 'finished full compaction\|serving Electrum RPC'
    echo "regtest ready, height $("${BCLI[@]}" getblockcount)"
}

case "${1:-}" in
    start) start ;;
    stop) "${COMPOSE[@]}" stop ;;
    reset) "${COMPOSE[@]}" down -v ;;
    mine) shift; mine "$@" ;;
    sendtoaddress) shift; sendtoaddress "$@" ;;
    height) "${BCLI[@]}" getblockcount ;;
    *) sed -n '2,9p' "$0"; exit 1 ;;
esac
