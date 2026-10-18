"""
"Your AI" tests: the three presets on synthetic data, free questions (on and off topic), the guard on
the model's answer, the rules fallbacks with their notes (mock, busy queue, errors, rejection), and
the endpoint, which must never let a counterparty's limits or strategy into the answer or the prompt.
"""

import json
import re
import time
from types import SimpleNamespace

import pytest
import requests

from backend import assistant
from backend import api_server
from backend.tests.test_advisor import (
    CEILING, DAY, NOW, PEPE, RESERVE, TARGET, USDT, _Queue, client, fake_qvac, market, session, swap, wallet,
)
from backend.tests.test_advisor import owner_data  # noqa: F401 (fixture)


@pytest.fixture(autouse=True)
def fresh_assistant(monkeypatch):
    """An empty cache and a clock at NOW (the endpoint tests use the real one)."""
    monkeypatch.setattr(assistant, "_cache", {})
    monkeypatch.setattr(assistant, "time", SimpleNamespace(time=lambda: NOW))


def vault_move(asset, amount, direction, days_ago):
    return {"id": f"v{amount}", "kind": "vault", "direction": direction, "asset": asset, "amount": amount, "t": NOW - days_ago * DAY}


def deal(asset_out, paid, asset_in, got, days_ago, session_id):
    return [
        {**swap(asset_out, paid, "out", days_ago), "id": f"{session_id}o", "session_id": session_id},
        {**swap(asset_in, got, "in", days_ago), "id": f"{session_id}i", "session_id": session_id},
    ]


IDLE_WALLET = wallet(btc_sats=1_000_000, usdt=10_000)
BTC = {"asset_id": "btc", "ticker": "BTC", "schema": "BTC", "precision": 8}


def ask(state=IDLE_WALLET, sessions=(), **kwargs):
    return assistant.ask("wallet_a", state, list(sessions), market(0.0001), **kwargs)


# ── Presets ─────────────────────────────────────────────────────────

def test_analyze_gives_the_advisor_signals_and_offers_the_vault_for_idle_funds():
    answer = ask(preset="analyze")
    assert [s["kind"] for s in answer["signals"]] == ["idle_funds"]
    assert answer == {
        "answer": "10,000 USDT sits idle.", "generated_by": "rules", "signals": answer["signals"],
        "action": "move_to_vault", "note": None,
    }


def test_week_lists_swaps_vault_moves_and_negotiations_of_the_last_seven_days():
    activity = (
        deal(USDT, 124, PEPE, 1_000_000, 1, "s1") + deal(USDT, 100, PEPE, 500_000, 2, "s2")
        + deal(USDT, 99, PEPE, 7, 9, "old")
        + [vault_move(USDT, 500, "out", 0)]
        # BTC only funds the network fees: not a fact of the week.
        + [{"id": "r1", "kind": "receive", "direction": "in", "asset": BTC, "amount": 50_000, "t": NOW}]
    )
    sessions = [{**session("buyer", "SETTLED", agreed=124), "updated_at": NOW - DAY}, {**session("buyer", "BLOCKED_BY_GATE"), "updated_at": NOW - 9 * DAY}]
    answer = ask(wallet(btc_sats=1_000_000, usdt=9_276, pepe=1_500_000, activity=activity), sessions, preset="week")
    assert [s["title"] for s in answer["signals"]] == [
        "Bought 1,500,000 PEPE for 224 USDT", "Moved 500 USDT to your Vault", "Negotiated 1 time",
    ]
    assert answer["signals"][0]["numbers"]["deals"] == 2
    assert answer["answer"] == "In the last 7 days you bought 1,500,000 PEPE for 224 USDT, moved 500 USDT to your Vault and negotiated 1 time."
    assert answer["action"] is None


def test_week_says_so_when_nothing_moved():
    assert ask(preset="week")["answer"] == "Nothing moved in the last 7 days."


def test_vault_reasons_on_idle_funds_only():
    answer = ask(preset="vault")
    assert answer["answer"] == "Yes, part of it. 10,000 USDT sits idle, 91% of your wallet: your Vault keeps it where agents can't touch it."
    assert answer["action"] == "move_to_vault"
    busy_funds = wallet(btc_sats=1_000_000, usdt=1_000, activity=[swap(USDT, 9_000, "out", 1)])
    calm = ask(busy_funds, preset="vault")
    assert (calm["answer"], calm["signals"], calm["action"]) == (assistant.NO_IDLE_FUNDS, [], None)


# ── Free questions ──────────────────────────────────────────────────

@pytest.mark.parametrize("question", ["What's the weather in Turin?", "Tell me a joke", "   "])
def test_off_topic_questions_never_reach_the_model(monkeypatch, question):
    calls = fake_qvac(monkeypatch)
    answer = ask(question=question)
    assert (answer["answer"], answer["generated_by"], answer["signals"]) == (assistant.OFF_TOPIC, "rules", [])
    assert calls == []


def test_a_free_question_gets_two_checked_sentences_from_facts_only(monkeypatch):
    calls = fake_qvac(monkeypatch, json.dumps({"answer": "10,000 USDT sits idle, 91% of your wallet. You could move part to your Vault."}))
    answer = ask(question="Is my money safe?")
    assert answer["generated_by"] == "qvac" and answer["note"] is None
    assert answer["answer"] == "10,000 USDT sits idle, 91% of your wallet. You could move part to your Vault."
    assert answer["action"] == "move_to_vault"
    [call] = calls
    system, user = call["payload"]["messages"]
    assert "10,000 USDT sits idle" in system["content"] and user["content"] == "Is my money safe?"
    assert call["timeout"] <= assistant.ASK_TIMEOUT_S
    # The same question on the same facts is answered from the cache.
    assert ask(question="is my money  safe?")["generated_by"] == "qvac" and len(calls) == 1


@pytest.mark.parametrize("content", [
    '{"answer": "You have 12,000 USDT idle."}',  # an invented number
    '{"answer": "Sell your BTC today, it sits idle."}',  # advice and a ticker no fact says
    '{"answer": "I think 10,000 USDT sits idle."}',  # first person
    '{"answer": "10,000 USDT sits idle. It is 91% of your wallet. Move part to your Vault. Agents cannot touch it there."}',  # too long
])
def test_a_rejected_answer_falls_back_to_rules_with_an_honest_note(monkeypatch, content):
    fake_qvac(monkeypatch, content)
    answer = ask(question="How is my wallet doing?")
    assert (answer["answer"], answer["generated_by"], answer["note"]) == ("10,000 USDT sits idle.", "rules", assistant.REJECTED_NOTE)


def test_a_question_about_the_week_falls_back_to_the_week_answer(monkeypatch):
    fake_qvac(monkeypatch, error=requests.Timeout("slow"))
    answer = ask(question="What happened lately?")
    assert (answer["answer"], answer["note"]) == ("Nothing moved in the last 7 days.", assistant.DOWN_NOTE)


def test_a_running_or_queued_negotiation_keeps_the_model_free(monkeypatch):
    calls = fake_qvac(monkeypatch)
    for kwargs in ({"preset": "analyze"}, {"question": "How is my wallet doing?"}):
        answer = ask(model_busy=lambda: True, **kwargs)
        assert (answer["generated_by"], answer["note"]) == ("rules", assistant.BUSY_NOTE)
    assert calls == []


def test_presets_are_worded_by_the_model_when_it_checks_out(monkeypatch):
    calls = fake_qvac(monkeypatch, '{"summary": "10,000 USDT sits idle, 91% of your wallet."}')
    answer = ask(preset="vault")
    assert (answer["answer"], answer["generated_by"], answer["action"]) == ("10,000 USDT sits idle, 91% of your wallet.", "qvac", "move_to_vault")
    assert len(calls) == 1
    # Nothing to say needs no model.
    assert ask(wallet(), preset="week")["generated_by"] == "rules" and len(calls) == 1


# ── Endpoint ────────────────────────────────────────────────────────

def test_ask_endpoint_returns_the_contract_shape(owner_data, monkeypatch):
    monkeypatch.setattr(assistant, "time", time)
    resp = client.post("/api/wallets/wallet_a/ask", json={"preset": "analyze"})
    assert resp.status_code == 200
    answer = resp.json()
    assert set(answer) == {"answer", "generated_by", "signals", "action", "note"}
    assert answer["action"] == "move_to_vault"
    for body in ({}, {"question": " "}, {"preset": "jokes"}, {"question": "x" * 281}, {"preset": "week", "extra": 1}):
        bad = client.post("/api/wallets/wallet_a/ask", json=body)
        assert bad.status_code == 400 and bad.json()["code"] == "invalid_request", body
    missing = client.post("/api/wallets/nobody/ask", json={"preset": "week"})
    assert missing.status_code == 404 and missing.json()["code"] == "wallet_not_found"


def test_counterparty_secrets_never_reach_the_answer_or_the_model(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch, '{"answer": "Your agent paid 17% below the list price."}')
    monkeypatch.setattr(assistant, "time", time)
    blobs = []
    for wallet_id in ("wallet_a", "wallet_b"):
        for body in ({"preset": "analyze"}, {"preset": "week"}, {"question": "What did my agent pay and what is the lowest the seller would take?"}):
            blobs.append(json.dumps(client.post(f"/api/wallets/{wallet_id}/ask", json=body).json()))
    blobs.append(json.dumps([c["payload"]["messages"] for c in calls]))
    assert calls
    assert not re.search(rf"\b({CEILING}|{TARGET}|{RESERVE})\b", " ".join(blobs))
    assert "whales" not in " ".join(blobs) and "146" not in " ".join(blobs)


def test_a_busy_queue_on_the_server_answers_with_the_quick_version(owner_data, monkeypatch):
    calls = fake_qvac(monkeypatch)
    monkeypatch.setattr(assistant, "time", time)
    monkeypatch.setattr(api_server, "negotiation_queue", _Queue(waiting=["sess_2"]))
    answer = client.post("/api/wallets/wallet_a/ask", json={"question": "Should I move funds to my Vault?"}).json()
    assert (answer["generated_by"], answer["note"], answer["action"]) == ("rules", assistant.BUSY_NOTE, "move_to_vault")
    assert calls == []
