"""The last settled PEPE price survives a backend restart (market.json in the data dir)."""

from backend.market import MarketManager


def test_settled_price_survives_a_restart(tmp_path):
    state = tmp_path / "market.json"
    first = MarketManager(state_file=state)
    assert first.last_pepe_price_usd is None
    first.record_settlement_price(0.000126)
    assert MarketManager(state_file=state).last_pepe_price_usd == 0.000126


def test_missing_or_unreadable_file_means_no_price_yet(tmp_path):
    assert MarketManager(state_file=tmp_path / "absent.json").last_pepe_price_usd is None
    broken = tmp_path / "market.json"
    broken.write_text("{not json")
    assert MarketManager(state_file=broken).last_pepe_price_usd is None
