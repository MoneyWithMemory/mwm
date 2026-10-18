"""
Advisor tests: each signal on synthetic data, the guards on the model's summary (numbers, words,
length), the rules fallbacks (mock, errors, a busy negotiation queue), the background phrasing with
its cache and backoff, and the endpoint, which must never let a counterparty's secret limits or
strategy (or the owner's own limits) into its output or into the model's prompt.
"""

import json
import re
import threading
import time

import pytest
import requests
from fastapi.testclient import TestClient

from backend import advisor
from backend import api_server
from backend.api_server import app
from backend.market import MarketState
from backend.qvac_negotiator import NegotiationTurn
from backend.memory_graph import MemoryGraph
from backend.session_store import SessionStatus, SessionStore

client = TestClient(app)
spawn_thread = advisor._spawn

NOW = 1_800_000_000
DAY = 86_400
USDT = {"asset_id": "rgb:usdt", "ticker": "USDT", "schema": "NIA", "precision": 0}
PEPE = {"asset_id": "rgb:pepe", "ticker": "PEPE", "schema": "NIA", "precision": 0}
STRICT = "Strict: open low and raise only in small steps, and only after the seller moves."
FLEXIBLE = "Flexible: closing matters more than the last dollar. Raise in larger steps toward a reasonable seller."


def market(pepe_price=None):
    return {
        "mode": "fixed_simulated",
        "sats_per_usd": 1000,
        "assets": [
            {"asset_id": "rgb:usdt", "ticker": "USDT", "precision": 0, "price_usd": 1.0, "source": "fixed_peg"},
            {"asset_id": "rgb:pepe", "ticker": "PEPE", "precision": 0, "price_usd": pepe_price, "source": "p2p_negotiation"},
        ],
    }


def wallet(btc_sats=0, usdt=0, pepe=0, activity=(), buyer_prompt=""):
    assets = [{"asset_id": "btc", "ticker": "BTC", "schema": "BTC", "precision": 8, "amount": btc_sats}]
    assets += [{**USDT, "amount": usdt}] if usdt else []
    assets += [{**PEPE, "amount": pepe}] if pepe else []
    return {
        "wallet_id": "wallet_a",
        "label": "Wallet A",
        "address": "bcrt1qowner",
        "assets": assets,
        "activity": list(activity),
        "agent_profile": {"buyer_ai_prompt": buyer_prompt, "seller_ai_prompt": ""},
    }


def swap(asset, amount, direction, days_ago):
    return {"kind": "swap", "direction": direction, "asset": asset, "amount": amount, "t": NOW - days_ago * DAY}


def session(role, state, agreed=None, ask=150, rounds=4, amount=1_000_000, prompt=""):
    """A SessionView as its owner sees it, with the strategy the owner gave their agent in it."""
    return {
        "state": state, "my_role": role, "asset": PEPE, "rgb_amount": amount, "agreed_price_usd": agreed,
        "list_price_usd": ask, "rounds": [{"n": n} for n in range(1, rounds + 1)], "my_ai_prompt": prompt,
    }


def kinds(signals):
    return [s["kind"] for s in signals]


# ── Signals ─────────────────────────────────────────────────────────

def test_empty_wallet_has_no_signals():
    assert advisor.compute_signals(wallet(), [], market(), NOW) == []
    assert advisor.template_summary([]) == "Nothing needs your attention right now."


def test_negotiation_savings_compare_settled_deals_with_the_public_list_price():
    sessions = [
        session("buyer", "SETTLED", agreed=123),
        session("buyer", "AWAITING_SIGNATURES", agreed=120),  # not settled yet
        session("seller", "SETTLED", agreed=130, ask=150),
        session("seller", "SETTLED", agreed=140, ask=150),
    ]
    buy, sell = advisor.compute_signals(wallet(), sessions, market(), NOW)[:2]
    assert (buy["id"], buy["severity"]) == ("negotiation_savings:buyer", "info")
    assert buy["title"] == "Paid 18% below the list price"
    assert buy["detail"] == "$123 for 1,000,000 PEPE, listed at $150."
    assert buy["numbers"] == {"paid_usd": 123, "ask_usd": 150, "saved_usd": 27, "pct_below": 18, "deals": 1, "amount": 1_000_000}
    assert sell["title"] == "Sold 10% below your asking price"
    assert sell["detail"] == "$270 for $300 listed, over 2 sales."
    assert sell["numbers"]["received_usd"] == 270
    [full] = advisor.compute_signals(wallet(), [session("buyer", "SETTLED", agreed=150)], market(), NOW)
    assert (full["title"], full["numbers"]["pct_below"]) == ("Paid the full list price", 0)


def test_idle_funds_quote_the_balance_that_trades_barely_used():
    # 10,000 USDT next to $1,000 of BTC, never traded: 91% of the wallet sits idle.
    [tip] = advisor.compute_signals(wallet(btc_sats=1_000_000, usdt=10_000), [], market(), NOW)
    assert (tip["id"], tip["severity"]) == ("idle_funds:rgb:usdt", "tip")
    assert tip["title"] == "10,000 USDT sits idle"
    assert tip["detail"] == "91% of your wallet. Move part to your Vault, where agents can't touch it."
    assert tip["numbers"] == {"idle_amount": 10_000, "share_pct": 91, "spent_amount": 0, "window_days": 7}

    # The amount and the share are the balance's own, as Assets and Allocation show them: what trades
    # spent is already gone. Trades older than a week do not count.
    week = wallet(btc_sats=1_000_000, usdt=9_000, activity=[swap(USDT, 1_000, "out", 2), swap(USDT, 5_000, "out", 30)])
    [tip] = advisor.compute_signals(week, [], market(), NOW)
    assert (tip["title"], tip["numbers"]["share_pct"], tip["numbers"]["spent_amount"]) == ("9,000 USDT sits idle", 90, 1_000)

    # Money the agents keep busy is not idle: this week's trades spent more than a quarter of it.
    busy = wallet(btc_sats=1_000_000, usdt=6_000, activity=[swap(USDT, 2_001, "out", 2)])
    assert advisor.compute_signals(busy, [], market(), NOW) == []
    # Below the share threshold (and BTC, which pays the fees) there is nothing to say.
    assert advisor.compute_signals(wallet(btc_sats=1_000_000, usdt=500), [], market(), NOW) == []


def test_concentration_warns_on_an_asset_whose_price_can_move():
    # 8,200,000 PEPE at $0.001 = $8,200 against $1,800 of USDT that trades keep busy.
    busy_usdt = [swap(USDT, 1_800, "out", 1)]
    signals = advisor.compute_signals(wallet(usdt=1_800, pepe=8_200_000, activity=busy_usdt), [], market(0.001), NOW)
    assert kinds(signals) == ["concentration", "idle_funds"]
    warning = signals[0]
    assert (warning["id"], warning["severity"]) == ("concentration:rgb:pepe", "warning")
    assert warning["title"] == "82% of your wallet is PEPE"
    assert warning["detail"] == "If its price drops, most of your wallet's value drops with it."
    assert warning["numbers"] == {"share_pct": 82, "value_usd": 8_200}

    # Not for the BTC that pays the fees, nor for a USD-pegged balance (that one is only idle).
    assert advisor.compute_signals(wallet(btc_sats=9_000_000, usdt=150), [], market(), NOW) == []
    assert kinds(advisor.compute_signals(wallet(btc_sats=1_000_000, usdt=10_000), [], market(), NOW)) == ["idle_funds"]
    # Unpriced assets (PEPE before its first trade) count for nothing.
    assert advisor.compute_signals(wallet(btc_sats=200_000, pepe=1_000_000), [], market(None), NOW) == []


def test_pace_needs_history_and_names_the_strategy():
    one = [session("buyer", "SETTLED", agreed=123, rounds=4)]
    assert kinds(advisor.compute_signals(wallet(), one, market(), NOW)) == ["negotiation_savings"]

    # An agreement counts as a deal even before (or without) the signatures.
    two = one + [session("buyer", "AWAITING_SIGNATURES", agreed=125, rounds=6)]
    pace = next(s for s in advisor.compute_signals(wallet(), two, market(), NOW) if s["kind"] == "pace")
    assert (pace["title"], pace["severity"]) == ("Agreed in 2 of 2 negotiations", "info")
    assert pace["detail"] == "Balanced buying strategy, about 5 rounds per deal."

    # Mostly no deal: a tip. Blocks before the agents spoke and cancelled talks are left out, strategy included.
    stalled = [
        session("buyer", "SETTLED", agreed=123, prompt=STRICT),
        session("buyer", "BLOCKED_BY_GATE", rounds=10, prompt=STRICT),
        session("buyer", "BLOCKED_BY_GATE", rounds=3, prompt=STRICT),
        session("buyer", "BLOCKED_BY_GATE", rounds=0, prompt=FLEXIBLE),
        session("buyer", "CANCELLED_BY_USER", rounds=2, prompt=FLEXIBLE),
    ]
    pace = next(s for s in advisor.compute_signals(wallet(), stalled, market(), NOW) if s["kind"] == "pace")
    assert (pace["title"], pace["severity"]) == ("Agreed in 1 of 3 negotiations", "tip")
    assert pace["detail"] == "Strict buying strategy: 2 ended with no deal. Flexible may close more."
    assert pace["numbers"] == {"negotiations": 3, "deals": 1, "no_deals": 2, "avg_rounds": 4}

    own_words = "Hold firm on Fridays."
    seller = [session("seller", "BLOCKED_BY_GATE", rounds=5, prompt=own_words), session("seller", "BLOCKED_BY_GATE", rounds=7, prompt=own_words)]
    [pace] = advisor.compute_signals(wallet(), seller, market(), NOW)
    assert (pace["title"], pace["detail"]) == ("No deal in 2 negotiations", "Your own selling strategy: 2 ended with no deal. Flexible may close more.")
    assert advisor.template_summary([pace]) == "Your agent made no deal in 2 negotiations."


def test_pace_reads_the_strategy_each_negotiation_ran_with_not_the_profile():
    # A buyer picks the strategy per negotiation: the profile's buyer prompt (Strict here) is not it.
    flexible = [session("buyer", "BLOCKED_BY_GATE", rounds=3, prompt=FLEXIBLE)] * 2
    [pace] = advisor.compute_signals(wallet(buyer_prompt=STRICT), flexible, market(), NOW)
    assert pace["detail"] == "Flexible buying strategy: 2 ended with no deal."

    # Different strategies: none is named, and Flexible is suggested only when none of them was Flexible.
    mixed = [session("buyer", "BLOCKED_BY_GATE", rounds=3, prompt=STRICT), session("buyer", "BLOCKED_BY_GATE", rounds=4)]
    assert advisor.compute_signals(wallet(), mixed, market(), NOW)[0]["detail"] == "As a buyer: 2 ended with no deal. Flexible may close more."
    mixed[1] = session("buyer", "BLOCKED_BY_GATE", rounds=4, prompt=FLEXIBLE)
    assert advisor.compute_signals(wallet(), mixed, market(), NOW)[0]["detail"] == "As a buyer: 2 ended with no deal."
    sales = [session("seller", "SETTLED", agreed=140, rounds=2, prompt=STRICT), session("seller", "SETTLED", agreed=130, rounds=4)]
    pace = next(s for s in advisor.compute_signals(wallet(), sales, market(), NOW) if s["kind"] == "pace")
    assert pace["detail"] == "As a seller, about 3 rounds per deal."
    # Deals closed in the first round.
    quick = [session("seller", "SETTLED", agreed=140, rounds=1)] * 2
    pace = next(s for s in advisor.compute_signals(wallet(), quick, market(), NOW) if s["kind"] == "pace")
    assert pace["detail"] == "Balanced selling strategy, about 1 round per deal."


def test_signals_are_short_most_severe_first_and_at_most_four():
    sessions = [session("buyer", "SETTLED", agreed=90_000, ask=1_234_567, amount=987_654_321)] * 3
    sessions += [session("seller", "SETTLED", agreed=100, ask=150)] * 2 + [session("seller", "BLOCKED_BY_GATE", rounds=9)] * 3
    state = wallet(btc_sats=1_000_000, usdt=9_999_999, pepe=987_654_321)
    signals = advisor.compute_signals(state, sessions, market(0.5), NOW)
    assert len(signals) == advisor.MAX_SIGNALS
    ranks = [advisor.SEVERITY_RANK[s["severity"]] for s in signals]
    assert ranks == sorted(ranks)
    for s in signals:
        assert len(s["title"]) <= advisor.TITLE_MAX and len(s["detail"]) <= advisor.DETAIL_MAX, s


def test_template_summary_joins_the_top_two_signals():
    signals = advisor.compute_signals(wallet(btc_sats=1_000_000, usdt=10_000), [session("buyer", "SETTLED", agreed=123)], market(), NOW)
    assert advisor.template_summary(signals) == "10,000 USDT sits idle, and your agent paid 18% below the list price."
    sales = [session("seller", "SETTLED", agreed=135), session("seller", "CANCELLED_BY_USER", agreed=140)]
    signals = advisor.compute_signals(wallet(), sales, market(), NOW)
    assert advisor.template_summary(signals) == "Your agent sold 10% below your asking price, and agreed in 2 of 2 negotiations."


# ── Phrasing ────────────────────────────────────────────────────────

class _Reply:
    def __init__(self, content):
        self._content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


def fake_qvac(monkeypatch, content='{"summary": "10,000 USDT sits idle."}', error=None, gate=None):
    """Live QVAC mode with requests.post stubbed (held until `gate` is set, if any): returns the calls made."""
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "payload": json, "timeout": timeout})
        if gate:
            assert gate.wait(5)
        if error:
            raise error
        return _Reply(content)

    monkeypatch.setattr(advisor.settings, "QVAC_MOCK", False)
    monkeypatch.setattr(advisor.requests, "post", post)
    return calls


@pytest.fixture(autouse=True)
def fresh_advisor(monkeypatch):
    """An empty cache and an idle worker, which runs inline unless a test starts real threads."""
    monkeypatch.setattr(advisor, "_cache", {})
    monkeypatch.setattr(advisor, "_jobs", {})
    monkeypatch.setattr(advisor, "_in_progress", None)
    monkeypatch.setattr(advisor, "_worker_running", False)
    monkeypatch.setattr(advisor, "_spawn", lambda target: target())


SIGNALS = advisor.compute_signals(wallet(btc_sats=1_000_000, usdt=10_000), [session("buyer", "SETTLED", agreed=123)], market(), NOW)


def test_numeric_guard_accepts_formatted_numbers_and_rejects_invented_ones():
    ok = "You have 10,000 USDT idle, 91% of your wallet, and your agent paid $123 on a $150 ask: 18% below, two wins."
    assert advisor.invented_numbers(ok, SIGNALS) == []
    assert advisor.invented_numbers("Your agent saved $30 on 1.5 million PEPE.", SIGNALS) == ["30", "1.5 million"]
    assert advisor.invented_numbers("A million PEPE for $123.00 in 7 days.", SIGNALS) == []
    assert advisor.invented_numbers("Nine deals, about 18.4% off.", SIGNALS) == ["18.4", "Nine"]
    # Spelled out too: eighteen is in the signals, fifteen is not; a zero never is (no signal shows one).
    assert advisor.invented_numbers("Your agent paid fifteen percent below, not eighteen.", SIGNALS) == ["fifteen"]
    assert advisor.invented_numbers("Thirteen deals, nineteen percent, a dozen dollars.", SIGNALS) == ["Thirteen", "nineteen", "dozen"]
    assert advisor.invented_numbers("Your agent paid zero dollars, $0 in fees.", SIGNALS) == ["0", "zero"]
    # A sign is part of the number: -18% is not the 18% below the list price.
    assert advisor.invented_numbers("Your agent paid -18% below the ask.", SIGNALS) == ["-18"]


def test_word_guard_keeps_the_summary_to_what_the_signals_say():
    ok = "Your agent paid 18% below the list price, and 10,000 USDT sits idle: move part to your Vault."
    assert advisor.unsupported_words(ok, SIGNALS) == []
    assert advisor.unsupported_words("Half of your wallet sits idle, so sell your BTC today.", SIGNALS) == ["Half", "sell", "today", "BTC"]
    assert advisor.unsupported_words("As an AI model I cannot give financial advice.", SIGNALS) == ["AI", "I"]
    # The Vault comes with idle funds, and only with them; so does a ticker no signal names.
    assert advisor.unsupported_words("Move part of your USDT to your Vault.", SIGNALS[1:]) == ["Vault", "USDT"]


def test_phrase_uses_the_model_sentence_when_it_checks_out(monkeypatch):
    calls = fake_qvac(monkeypatch, '<think>short</think>```json\n{"summary": "Your agent paid $123, 18% below the list price, and 10,000 USDT sits idle."}\n```')
    assert advisor.phrase(SIGNALS) == ("Your agent paid $123, 18% below the list price, and 10,000 USDT sits idle.", "qvac")
    [call] = calls
    assert call["url"].endswith("/chat/completions") and call["timeout"] <= advisor.PHRASE_TIMEOUT_S
    assert call["payload"]["model"] == advisor.settings.QVAC_MODEL and call["payload"]["reasoning_budget"] == 0
    assert "10,000 USDT sits idle" in call["payload"]["messages"][1]["content"]


@pytest.mark.parametrize("summary", [
    "10,000 USDT, 91% of your wallet, sits idle: move part to your Vault, where agents can't touch it.",
    "Your agent saved $27 on 1,000,000 PEPE; consider moving part of your idle USDT to the Vault.",
    "Move part of your 10,000 USDT to your Vault, out of your agents' reach.",
])
def test_phrase_keeps_a_faithful_rewording(monkeypatch, summary):
    fake_qvac(monkeypatch, json.dumps({"summary": summary}))
    assert advisor.phrase(SIGNALS) == (summary, "qvac")


@pytest.mark.parametrize("content", [
    '{"summary": "Your agent paid $119, 21% below the ask."}',  # invented numbers
    '{"summary": "Your agent paid fifteen percent below the ask."}',  # an invented number in words
    '{"summary": "Half of your wallet sits idle: 10,000 USDT."}',  # an approximation (it is 91%)
    '{"summary": "Thousands of USDT sit idle."}',
    '{"summary": "Your agent paid ½ of the ask."}',  # a number the guard cannot read
    '{"summary": "Your agent paid 18% below the ask. Sell your BTC and buy more PEPE now."}',  # advice beyond the signals
    '{"summary": "Move all your USDT to your Vault today, your agent may lose it."}',
    '{"summary": "Your agent paid $150 on a $123 ask, 18% above it."}',  # a fact turned around
    '{"summary": "As an AI model I cannot give financial advice."}',
    # A real QVAC reply: what the Vault does, said of the idle money (which the agents can spend).
    '{"summary": "10,000 USDT is idle, making up 91% of your wallet. Your agent can\'t access it, but you paid 18% below the list price."}',
    "<think>The owner has 10,000 USDT",  # a reasoning block cut short
    '{"summary": "Your agent paid 18% below the list price. 10,000 USDT sits idle. Move part to your Vault."}',
    '{"summary": "' + "Your agent paid 18% below the list price, " * 3 + 'and 10,000 USDT sits idle."}',  # too long
    '{"verdict": "no summary field"}',
    "",
])
def test_phrase_falls_back_to_rules_on_a_bad_model_reply(monkeypatch, content):
    fake_qvac(monkeypatch, content)
    assert advisor.phrase(SIGNALS) == (advisor.template_summary(SIGNALS), "rules")


def test_phrase_mentions_the_vault_only_with_idle_funds(monkeypatch):
    fake_qvac(monkeypatch, '{"summary": "Your agent paid 18% below the ask; move some USDT to your Vault."}')
    assert advisor.phrase(SIGNALS)[1] == "qvac"
    savings_only = [s for s in SIGNALS if s["kind"] != "idle_funds"]
    assert advisor.phrase(savings_only)[1] == "rules"


@pytest.mark.parametrize("error", [requests.ConnectionError("refused"), requests.Timeout("read timed out")])
def test_phrase_falls_back_to_rules_when_qvac_fails(monkeypatch, error):
    fake_qvac(monkeypatch, error=error)
    assert advisor.phrase(SIGNALS) == (advisor.template_summary(SIGNALS), "rules")


def test_phrase_never_calls_qvac_in_mock_mode_or_without_signals(monkeypatch):
    calls = fake_qvac(monkeypatch)
    assert advisor.phrase([]) == ("Nothing needs your attention right now.", "rules")
    monkeypatch.setattr(advisor.settings, "QVAC_MOCK", True)
    assert advisor.phrase(SIGNALS)[1] == "rules"
    assert calls == []


# ── Background phrasing & cache ─────────────────────────────────────

IDLE_WALLET = wallet(btc_sats=1_000_000, usdt=10_000)


class Clock:
    def __init__(self):
        self.t = float(NOW)

    def time(self):
        return self.t


@pytest.fixture()
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(advisor, "time", fake)
    return fake


def wait_for_worker():
    deadline = time.time() + 5
    while advisor._worker_running and time.time() < deadline:
        time.sleep(0.01)
    assert not advisor._worker_running


def test_the_signals_come_at_once_and_the_sentence_follows_from_the_background(monkeypatch):
    monkeypatch.setattr(advisor, "_spawn", spawn_thread)
    release = threading.Event()
    calls = fake_qvac(monkeypatch, gate=release)
    first = advisor.advise("wallet_a", IDLE_WALLET, [], market())
    assert (first["generated_by"], first["phrasing"], kinds(first["signals"])) == ("rules", True, ["idle_funds"])
    release.set()
    wait_for_worker()
    second = advisor.advise("wallet_a", IDLE_WALLET, [], market())
    assert (second["generated_by"], second["phrasing"], second["summary"]) == ("qvac", False, "10,000 USDT sits idle.")
    assert len(calls) == 1


def test_the_worker_phrases_one_call_at_a_time_and_only_a_wallets_latest_signals(monkeypatch):
    monkeypatch.setattr(advisor, "_spawn", spawn_thread)
    release = threading.Event()
    calls = fake_qvac(monkeypatch, gate=release)
    advisor.advise("wallet_a", IDLE_WALLET, [], market())
    for usdt in (5_000, 4_000):  # wallet_b's signals change while wallet_a is being phrased
        assert advisor.advise("wallet_b", wallet(btc_sats=1_000_000, usdt=usdt), [], market())["phrasing"]
    release.set()
    wait_for_worker()
    prompts = [c["payload"]["messages"][1]["content"] for c in calls]
    assert len(prompts) == 2 and "10,000 USDT" in prompts[0] and "4,000 USDT" in prompts[1]


def test_a_negotiation_queued_after_the_request_still_gets_the_model_first(monkeypatch):
    calls = fake_qvac(monkeypatch)
    free_then_busy = iter([False, True])  # free when the request comes, busy when the worker would call the model
    advice = advisor.advise("wallet_a", IDLE_WALLET, [], market(), model_busy=lambda: next(free_then_busy))
    assert (advice["generated_by"], advice["phrasing"], calls) == ("rules", False, [])
    # Nothing is left behind: once the model is free, the next poll phrases.
    assert advisor.advise("wallet_a", IDLE_WALLET, [], market())["generated_by"] == "qvac"


def test_a_phrased_summary_is_cached_and_refreshed_without_a_gap(clock, monkeypatch):
    calls = fake_qvac(monkeypatch)
    for _ in range(40):  # the UI polls every 30 s: 20 minutes on unchanged signals
        advice = advisor.advise("wallet_a", IDLE_WALLET, [], market())
        assert (advice["generated_by"], advice["summary"]) == ("qvac", "10,000 USDT sits idle.")
        clock.t += 30
    assert len(calls) == 2  # phrased at once, then again after the cache's 10 minutes

    # A failed refresh keeps the last good sentence for the same signals, which is still true.
    fake_qvac(monkeypatch, error=requests.Timeout("read timed out"))
    clock.t += advisor.CACHE_TTL_S / 2
    assert advisor.advise("wallet_a", IDLE_WALLET, [], market())["generated_by"] == "qvac"


def test_a_failing_phrasing_backs_off_while_the_ui_keeps_polling(clock, monkeypatch):
    calls = fake_qvac(monkeypatch, '{"summary": "About 9,000 USDT sits idle."}')  # always discarded
    for _ in range(40):
        assert advisor.advise("wallet_a", IDLE_WALLET, [], market())["generated_by"] == "rules"
        clock.t += 30
    # Tried at 0, 1, 3, 7 and 15 minutes: the wait doubles, up to the cache's 10 minutes.
    assert len(calls) == 5


# ── Endpoint ────────────────────────────────────────────────────────

class _Queue:
    def __init__(self, running=(), waiting=()):
        self._snapshot = {"running": list(running), "waiting": list(waiting)}

    def snapshot(self):
        return self._snapshot

    def position(self, session_id):
        return None


# Distinctive secrets: the buyer's ceiling and target, the seller's reserve and own strategy words.
CEILING, TARGET, RESERVE = 137, 121, 113
SELLER_WORDS = "Hold at 146 for the whales."


def negotiation(store, session_id, offers, agreed, status):
    """A session between wallet_a (buyer, Flexible) and wallet_b (seller, its own words)."""
    s = store.create_session(
        session_id=session_id, asset_id="rgb:pepe", asset_ticker="PEPE", asset_amount=1_000_000,
        payment_asset_id="rgb:usdt", payment_ticker="USDT", buyer_wallet_id="wallet_a", seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer", seller_address="bcrt1qseller", asking_price_usd=150,
        buyer_max_budget_usd=CEILING, seller_min_reserve_usd=RESERVE, buyer_target_usd=TARGET,
        buyer_ai_prompt=FLEXIBLE, seller_ai_prompt=SELLER_WORDS,
    )
    for n, (bid, ask) in enumerate(offers, start=1):
        s.history.append(NegotiationTurn(
            speaker_wallet_id="wallet_a", speaker_label="Wallet A", action="OFFER", offer_usd=bid,
            public_message=f"I offer {bid}.", private_thought=f"My ceiling is {CEILING}, my target {TARGET}.", round_number=n,
        ))
        s.history.append(NegotiationTurn(
            speaker_wallet_id="wallet_b", speaker_label="Wallet B", action="ACCEPT" if bid == ask else "OFFER", offer_usd=ask,
            public_message=f"I ask {ask}.", private_thought=f"My floor is {RESERVE}.", round_number=n,
        ))
    s.status = status
    s.agreed_price_usd = agreed


@pytest.fixture()
def owner_data(monkeypatch):
    """A settled 1,000,000 PEPE deal at 124 USDT on a 150 list price, between wallet_a and wallet_b."""
    store = SessionStore(MemoryGraph())
    negotiation(store, "sess_advice", [(100, 150), (112, 136), (124, 124)], 124, SessionStatus.SETTLED)
    states = {
        "wallet_a": wallet(btc_sats=997_000, usdt=9_876, pepe=1_000_000, activity=[swap(USDT, 124, "out", 0)]),
        "wallet_b": {**wallet(btc_sats=1_000_000, usdt=124), "wallet_id": "wallet_b"},
    }
    for state in states.values():
        state["agent_profile"].update({"buyer_max_ceiling_usd": CEILING, "buyer_target_usd": TARGET, "secret_min_reserve_usd": RESERVE})
        for item in state["activity"]:
            item["t"] = int(time.time())
    monkeypatch.setattr(api_server, "session_store", store)
    monkeypatch.setattr(api_server, "negotiation_queue", _Queue())
    monkeypatch.setattr(api_server, "get_wallet", lambda wallet_id: states[wallet_id])
    monkeypatch.setattr(api_server.market_manager, "get_market", lambda: MarketState(**market(0.000124)))
    return states


def whole_numbers(advice):
    """Every number a viewer can read in the advice (generated_at is a timestamp, not content)."""
    texts = [advice["summary"]] + [s["title"] + " " + s["detail"] for s in advice["signals"]]
    found = {int(n.replace(",", "")) for t in texts for n in re.findall(r"\d[\d,]*", t)}
    return found | {v for s in advice["signals"] for v in s["numbers"].values()}


def test_advice_endpoint_returns_the_contract_shape(owner_data):
    resp = client.get("/api/wallets/wallet_a/advice")
    assert resp.status_code == 200
    advice = resp.json()
    assert set(advice) == {"wallet_id", "generated_at", "generated_by", "phrasing", "summary", "signals"}
    assert (advice["wallet_id"], advice["generated_by"], advice["phrasing"]) == ("wallet_a", "rules", False)
    assert kinds(advice["signals"]) == ["idle_funds", "negotiation_savings"]
    assert advice["summary"] == "9,876 USDT sits idle, and your agent paid 17% below the list price."
    for s in advice["signals"]:
        assert set(s) == {"id", "kind", "severity", "title", "detail", "numbers"}

    missing = client.get("/api/wallets/nobody/advice")
    assert missing.status_code == 404
    assert missing.json() == {"code": "wallet_not_found", "message": "Wallet nobody does not exist"}


def test_counterparty_secrets_never_reach_the_advice_or_the_model(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch, '{"summary": "Your agent paid $124, 17% below the ask."}')
    for wallet_id in ("wallet_a", "wallet_b"):
        advice = client.get(f"/api/wallets/{wallet_id}/advice").json()
        assert advice["generated_by"] == "qvac"
        assert not whole_numbers(advice) & {CEILING, TARGET, RESERVE}, (wallet_id, advice)
    prompts = json.dumps([c["payload"]["messages"] for c in calls])
    assert len(calls) == 2 and not re.search(rf"\b({CEILING}|{TARGET}|{RESERVE})\b", prompts)
    seller = client.get("/api/wallets/wallet_b/advice").json()
    assert seller["signals"][0]["title"] == "Sold 17% below your asking price"


def test_each_owner_sees_only_the_strategy_of_their_own_agent(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch)
    for session_id in ("sess_no_deal_1", "sess_no_deal_2"):
        negotiation(api_server.session_store, session_id, [(100, 150), (105, 148)], None, SessionStatus.BLOCKED_BY_GATE)
    paces = {}
    for wallet_id in ("wallet_a", "wallet_b"):
        advice = client.get(f"/api/wallets/{wallet_id}/advice").json()
        paces[wallet_id] = next(s["detail"] for s in advice["signals"] if s["kind"] == "pace")
    assert paces == {
        "wallet_a": "Flexible buying strategy: 2 ended with no deal.",
        "wallet_b": "Your own selling strategy: 2 ended with no deal. Flexible may close more.",
    }
    # The seller's own words (and the number in them) never reach the advice or the model.
    blob = json.dumps(paces) + json.dumps([c["payload"]["messages"] for c in calls])
    assert "whales" not in blob and "146" not in blob


def test_a_busy_negotiation_queue_keeps_the_model_free(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch)
    for queue in (_Queue(running=["sess_1"]), _Queue(waiting=["sess_2"])):
        monkeypatch.setattr(api_server, "negotiation_queue", queue)
        assert client.get("/api/wallets/wallet_a/advice").json()["generated_by"] == "rules"
    assert calls == []


def test_the_phrased_summary_is_cached_per_wallet_and_signals(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch, '{"summary": "9,876 USDT sits idle."}')
    first = client.get("/api/wallets/wallet_a/advice").json()
    second = client.get("/api/wallets/wallet_a/advice").json()
    assert (first["generated_by"], second["summary"]) == ("qvac", "9,876 USDT sits idle.")
    assert len(calls) == 1
    # A cached summary is served even while a negotiation holds the model.
    monkeypatch.setattr(api_server, "negotiation_queue", _Queue(running=["sess_1"]))
    assert client.get("/api/wallets/wallet_a/advice").json()["generated_by"] == "qvac"
    # New signals, new phrasing.
    monkeypatch.setattr(api_server, "negotiation_queue", _Queue())
    owner_data["wallet_a"]["assets"][1]["amount"] = 8_000
    client.get("/api/wallets/wallet_a/advice")
    assert len(calls) == 2
