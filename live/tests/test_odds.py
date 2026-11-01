import json
from decimal import Decimal
from typing import Any

from naebka_live.events import MatchState
from naebka_live.odds import over_probability, price_match, to_odds, win_probability
from naebka_live.odds_engine import REFRESH_S, REOPEN_DELAY_S, OddsEngine


def state(nw: tuple[int, int] = (20_000, 20_000), alive: tuple[int, int] = (16, 16), elapsed: int = 600) -> MatchState:
    return MatchState(elapsed_s=elapsed, net_worth=nw, objectives_alive=alive, objectives_mask=(0, 0))


def test_even_game_is_a_coin_flip() -> None:
    assert abs(win_probability(state()) - 0.5) < 1e-9


def test_net_worth_and_objectives_favour_the_leader() -> None:
    assert win_probability(state(nw=(60_000, 45_000), elapsed=1200)) > 0.65
    assert win_probability(state(alive=(16, 10))) > 0.7
    assert win_probability(state(alive=(10, 16))) < 0.3


def test_probability_is_clamped() -> None:
    p = win_probability(state(nw=(200_000, 10_000), alive=(16, 1), elapsed=2400))
    assert p <= 0.98


def test_odds_carry_the_margin_and_round_down() -> None:
    odds = to_odds([0.5, 0.5], 0.06)
    assert odds == [Decimal("1.88"), Decimal("1.88")]
    implied = sum(1 / float(o) for o in odds)
    assert 1.05 < implied < 1.08


def test_odds_respect_bounds() -> None:
    odds = to_odds([0.999, 0.001], 0.06)
    assert odds[0] >= Decimal("1.01")
    assert odds[1] <= Decimal("50.00")


def test_fast_destruction_projects_an_early_end() -> None:
    fast = state(alive=(6, 12), elapsed=15 * 60)
    slow = state(alive=(15, 15), elapsed=25 * 60)
    assert over_probability(fast, 30) < 0.5 < over_probability(slow, 30)


def test_duration_market_closes_once_the_line_is_passed() -> None:
    prices = {p.market_type: p for p in price_match(state(elapsed=31 * 60), 0.06)}
    assert prices["duration_over_under"].close
    assert not prices["match_winner"].close


class FakeBus:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    def publish(self, channel: str, message: str) -> None:
        self.messages.append(json.loads(message))


def event(etype: str, s: MatchState, event_id: str = "e1") -> dict[str, Any]:
    return {"type": etype, "match_id": "42", "event_id": event_id, "data": {"state": s.to_dict()}}


def test_engine_prices_immediately_on_discovery() -> None:
    bus = FakeBus()
    engine = OddsEngine(bus, 0.06)  # type: ignore[arg-type]
    engine.on_event(event("match.discovered", state()), now=0)
    assert len(bus.messages) == 1
    assert bus.messages[0]["markets"][0]["odds"] == {"side1": 1.88, "side2": 1.88}


def test_engine_waits_cooling_off_after_state_change() -> None:
    bus = FakeBus()
    engine = OddsEngine(bus, 0.06)  # type: ignore[arg-type]
    engine.on_event(event("match.discovered", state()), now=0)
    engine.on_event(event("objective.destroyed", state(alive=(16, 15)), "e2"), now=10)
    engine.tick(10 + REOPEN_DELAY_S / 2)
    assert len(bus.messages) == 1  # still suspended
    engine.tick(10 + REOPEN_DELAY_S)
    assert len(bus.messages) == 2
    assert bus.messages[1]["based_on_event_id"] == "e2"


def test_engine_ignores_tiny_moves_on_snapshots() -> None:
    bus = FakeBus()
    engine = OddsEngine(bus, 0.06)  # type: ignore[arg-type]
    engine.on_event(event("match.discovered", state()), now=0)
    engine.on_event(event("match.snapshot", state(nw=(20_050, 20_000)), "e2"), now=10)
    assert len(bus.messages) == 1


def test_engine_republishes_periodically_so_missed_updates_heal() -> None:
    bus = FakeBus()
    engine = OddsEngine(bus, 0.06)  # type: ignore[arg-type]
    engine.on_event(event("match.discovered", state()), now=0)
    engine.tick(REFRESH_S / 2)
    assert len(bus.messages) == 1
    engine.tick(REFRESH_S + 1)
    assert len(bus.messages) == 2


def test_early_game_duration_market_is_not_extreme() -> None:
    p_over = over_probability(state(alive=(15, 16), elapsed=5 * 60), 30)
    assert 0.3 < p_over < 0.8


def test_periodic_refresh_resends_unchanged_prices() -> None:
    bus = FakeBus()
    engine = OddsEngine(bus, 0.06)  # type: ignore[arg-type]
    engine.on_event(event("match.discovered", state()), now=0)
    engine.on_event(event("match.snapshot", state(nw=(20_100, 20_000)), "e2"), now=5)
    engine.tick(REFRESH_S + 1)
    assert bus.messages[-1]["markets"] == bus.messages[0]["markets"]


def test_untouched_objectives_mid_game_are_not_a_lock_for_over() -> None:
    p_over = over_probability(state(alive=(16, 16), elapsed=11 * 60), 30)
    assert p_over < 0.8
