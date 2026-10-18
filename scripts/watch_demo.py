#!/usr/bin/env python3
"""
Live, read-only view of the MwM demo for the terminal: one line per change in sessions
(state, rounds, signatures, settlement steps, txid), wallet balances, PEPE price and health.

Usage: python3 scripts/watch_demo.py [--api http://127.0.0.1:8000] [--interval 1.0]
Stop with Ctrl+C. Uses only the public API, never writes anything.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

TERMINAL = {"SETTLED", "CANCELLED_BY_USER", "BLOCKED_BY_GATE", "FAILED", "EXPIRED"}
STEP_CODE = {"done": "d", "running": "r", "pending": "p", "failed": "f"}
BALANCE_WALLETS = ("wallet_a", "wallet_b")


def say(text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')}  {text}", flush=True)


class Watcher:
    def __init__(self, api: str) -> None:
        self.api = api.rstrip("/")
        self.label_by_id: dict = {}
        self.label_by_address: dict = {}
        self.viewer: dict = {}      # session_id -> a participant wallet_id allowed to read it
        self.printed: dict = {}     # session_id -> (state, description) last printed
        self.balances: dict = {}
        self.health = None
        self.pepe_price = "unset"
        self.reachable = True

    def get(self, path: str):
        with urllib.request.urlopen(self.api + path, timeout=10) as resp:
            return json.loads(resp.read())

    def refresh_wallets(self) -> None:
        wallets = self.get("/api/wallets")
        self.label_by_id = {w["wallet_id"]: w["label"] for w in wallets}
        self.label_by_address = {w["address"]: w["label"] for w in wallets}

    def watch_health_and_market(self) -> None:
        health = self.get("/api/health")
        if health != self.health:
            down = [k for k, ok in health.items() if not ok]
            say("HEALTH   " + ("all ok" if not down else "DOWN: " + ", ".join(down)))
            self.health = health
        pepe = next((a for a in self.get("/api/market")["assets"] if a["ticker"] == "PEPE"), None)
        price = pepe["price_usd"] if pepe else None
        if price != self.pepe_price:
            if self.pepe_price != "unset" or price is not None:
                say("MARKET   PEPE price " + ("—" if price is None else f"${price:.6f}"))
            self.pepe_price = price

    def watch_balances(self) -> None:
        for wid in BALANCE_WALLETS:
            if wid not in self.label_by_id:
                continue
            state = self.get(f"/api/wallets/{wid}")
            amounts = tuple((a["ticker"], a["amount"]) for a in state["assets"])
            if amounts != self.balances.get(wid):
                text = " · ".join(f"{t} {a:,}" for t, a in amounts)
                say(f"BALANCE  {state['label']:<9} {text}")
                self.balances[wid] = amounts

    def describe(self, view: dict, viewer_wid: str) -> str:
        me = self.label_by_id.get(viewer_wid, viewer_wid)
        other = self.label_by_address.get(view["counterparty_address"]) or view["counterparty_address"][:12] + "…"
        buyer, seller = (me, other) if view["my_role"] == "buyer" else (other, me)
        parts = [f"{buyer} → {seller}", f"{view['rgb_amount']:,} {view['asset']['ticker']}"]
        if view.get("queue_position"):
            parts.append(f"queued #{view['queue_position']}")
        if view["rounds"]:
            r = view["rounds"][-1]
            buyer_part = f"{r['buyer_action'] or '…'} {r['buyer_offer_usd'] if r['buyer_offer_usd'] is not None else ''}"
            seller_part = f"{r['seller_action'] or '…'} {r['seller_offer_usd'] if r['seller_offer_usd'] is not None else ''}"
            cap = f"/{view['max_rounds']}" if view.get("max_rounds") else ""
            parts.append(f"R{r['n']}{cap} buyer {buyer_part.strip()} · seller {seller_part.strip()}")
        if view["thinking"]:
            parts.append(f"thinking: {view['thinking']}")
        if view["agreed_price_usd"]:
            parts.append(f"agreed ${view['agreed_price_usd']}")
        if view["state"] in ("AWAITING_SIGNATURES", "SETTLING", "SETTLED", "FAILED"):
            parts.append(f"signed buyer {'✓' if view['buyer_signed'] else '·'} seller {'✓' if view['seller_signed'] else '·'}")
        if view["settlement_steps"]:
            parts.append("steps " + "".join(STEP_CODE.get(s["status"], "?") for s in view["settlement_steps"]))
        if view["txid"]:
            parts.append(f"txid {view['txid'][:16]}…")
        if view["state"] == "BLOCKED_BY_GATE" and view["gate"]:
            parts.append("reasons: " + "; ".join(view["gate"]["reasons"]))
        if view["failure"]:
            parts.append("failure: " + view["failure"]["message"][:160])
        return " | ".join(parts)

    def watch_sessions(self) -> None:
        for wid in self.label_by_id:
            for summary in self.get(f"/api/sessions?wallet_id={wid}"):
                self.viewer.setdefault(summary["session_id"], wid)
        for sid, wid in self.viewer.items():
            last = self.printed.get(sid)
            if last and last[0] in TERMINAL:
                continue
            view = self.get(f"/api/sessions/{sid}?wallet_id={wid}")
            current = (view["state"], self.describe(view, wid))
            if current != last:
                tag = "NEW     " if last is None else "SESSION "
                say(f"{tag} {sid}  {current[0]:<19} {current[1]}")
                self.printed[sid] = current

    def run(self, interval: float) -> None:
        say(f"watching {self.api} (read-only, Ctrl+C to stop)")
        tick = 0
        while True:
            try:
                if tick % 5 == 0:
                    self.refresh_wallets()
                    self.watch_health_and_market()
                self.watch_sessions()
                if tick % 3 == 0:
                    self.watch_balances()
                if not self.reachable:
                    say("backend reachable again")
                    self.reachable = True
            except (urllib.error.URLError, OSError) as exc:
                if self.reachable:
                    say(f"backend unreachable ({exc}); retrying…")
                    self.reachable = False
            tick += 1
            time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    try:
        Watcher(args.api).run(args.interval)
    except KeyboardInterrupt:
        print()
        sys.exit(0)


if __name__ == "__main__":
    main()
