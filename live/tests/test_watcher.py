import time
from typing import Any, cast

from naebka_live.deadlock_api import PlayerLookupUnavailable, parse_active_match
from naebka_live.events import MatchState
from naebka_live.watcher import (
    MISSING_POLLS_BEFORE_END,
    MISSING_POLLS_WHILE_BLIND,
    Watcher,
    diff_events,
    pick_candidates,
)


def state(nw: tuple[int, int] = (10_000, 10_000), alive: tuple[int, int] = (16, 16), winner: int | None = None,
          elapsed: int = 600) -> MatchState:
    return MatchState(elapsed_s=elapsed, net_worth=nw, objectives_alive=alive, objectives_mask=(0, 0),
                      winning_team=winner)


def types(events: list[Any]) -> list[str]:
    return [e.type for e in events]


def test_quiet_poll_is_a_snapshot() -> None:
    assert types(diff_events("1", state(), state(nw=(10_500, 10_400)))) == ["match.snapshot"]


def test_objective_loss_is_reported_per_team() -> None:
    events = diff_events("1", state(), state(alive=(15, 14)))
    assert types(events) == ["objective.destroyed", "objective.destroyed"]
    assert events[0].data["team"] == 0 and events[0].data["count"] == 1
    assert events[1].data["team"] == 1 and events[1].data["count"] == 2


def test_lead_change_is_a_swing() -> None:
    events = diff_events("1", state(nw=(30_000, 27_000)), state(nw=(30_000, 33_000)))
    assert types(events) == ["networth.swing"]
    assert events[0].data["leader"] == 1


def test_small_lead_flip_is_noise() -> None:
    assert types(diff_events("1", state(nw=(30_000, 29_900)), state(nw=(30_000, 30_300)))) == ["match.snapshot"]


def test_winner_appearing_ends_the_match() -> None:
    events = diff_events("1", state(), state(winner=1))
    assert types(events) == ["match.ended"]
    assert events[0].data["winning_team"] == 1


def raw_match(match_id: int, game_mode: int = 1, start_ago: int = 120, score: int = 2000) -> dict[str, Any]:
    return {
        "match_id": match_id, "start_time": 1_000_000 - start_ago, "game_mode": game_mode, "match_mode": 4,
        "match_score": score, "spectators": 3, "net_worth_team_0": 5000, "net_worth_team_1": 4800,
        "objectives_mask_team0": 65535, "objectives_mask_team1": 65093, "winning_team": None,
        "players": [{"account_id": 1, "team": 0, "hero_id": 2}, {"account_id": 3, "team": 1, "hero_id": 4}],
    }


def test_parse_counts_alive_objectives_from_bitmask() -> None:
    m = parse_active_match(raw_match(7), now=1_000_000)
    assert m.state.objectives_alive == (16, 10)
    assert m.state.elapsed_s == 120
    assert m.match_id == "7"


def test_candidates_are_fresh_normal_matches_best_rank_first() -> None:
    active = [
        parse_active_match(raw_match(1, score=1500), now=1_000_000),
        parse_active_match(raw_match(2, game_mode=4, score=9000), now=1_000_000),  # Street Brawl
        parse_active_match(raw_match(3, start_ago=20 * 60, score=9000), now=1_000_000),  # too late
        parse_active_match(raw_match(4, score=2500), now=1_000_000),
        parse_active_match(raw_match(5, score=3000), now=1_000_000),
    ]
    picked = pick_candidates(active, tracked={"5"}, slots=2)
    assert [m.match_id for m in picked] == ["4", "1"]


class FakeBus:
    def __init__(self) -> None:
        self.published: list[str] = []
        self.values: dict[str, Any] = {}

    def publish(self, channel: str, message: str) -> None:
        self.published.append(message)

    def set(self, key: str, value: Any, ex: int | None = None) -> None:
        self.values[key] = value


class BlindApi:
    """The live list no longer has the match, and the player lookup can't run (only the bot answers)."""

    last_source = "deadlock-bot"

    def __init__(self, first: list[Any]) -> None:
        self.first = first
        self.calls = 0

    def active_matches(self, account_id: int | None = None) -> list[Any]:
        if account_id is not None:
            raise PlayerLookupUnavailable("deadlock-api is rate limited")
        self.calls += 1
        return self.first if self.calls == 1 else []


def test_match_is_not_ended_early_while_the_player_lookup_is_blind() -> None:
    raw = raw_match(1)
    raw["start_time"] = int(time.time()) - 120  # a fresh match, so the watcher picks it
    api = BlindApi([parse_active_match(raw)])
    bus = FakeBus()
    watcher = Watcher(cast(Any, api), cast(Any, bus), max_tracked=4)
    watcher.poll_once()
    assert "1" in watcher.tracked

    for _ in range(MISSING_POLLS_BEFORE_END):
        watcher.poll_once()
    assert "1" in watcher.tracked, "three blind polls must not end the match"

    for _ in range(MISSING_POLLS_WHILE_BLIND - MISSING_POLLS_BEFORE_END):
        watcher.poll_once()
    assert "1" not in watcher.tracked
    assert any('"match.ended"' in m for m in bus.published)

    watcher.heartbeat()
    assert bus.values["watcher:source"] == "deadlock-bot"
