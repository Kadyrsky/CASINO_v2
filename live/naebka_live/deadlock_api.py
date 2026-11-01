"""Thin client for the public Deadlock API (https://api.deadlock-api.com). Only the watcher uses it."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from naebka_live.events import MatchState

GAME_MODE_NORMAL = 1


@dataclass(frozen=True)
class ActiveMatch:
    match_id: str
    start_time: int
    game_mode: int
    match_mode: int
    region: str
    match_score: int
    spectators: int
    players: list[dict[str, int]]
    state: MatchState


def _popcount(mask: int) -> int:
    return bin(mask & 0xFFFFFFFF).count("1")


def parse_active_match(raw: dict[str, Any], now: float | None = None) -> ActiveMatch:
    """Translate one entry of GET /v1/matches/active into the normalized model."""
    current = time.time() if now is None else now
    start = int(raw.get("start_time") or current)
    mask0 = int(raw.get("objectives_mask_team0") or 0)
    mask1 = int(raw.get("objectives_mask_team1") or 0)
    winning = raw.get("winning_team")
    state = MatchState(
        elapsed_s=max(0, int(current) - start),
        net_worth=(int(raw.get("net_worth_team_0") or 0), int(raw.get("net_worth_team_1") or 0)),
        objectives_alive=(_popcount(mask0), _popcount(mask1)),
        objectives_mask=(mask0, mask1),
        spectators=int(raw.get("spectators") or 0),
        winning_team=int(winning) if winning is not None else None,
    )
    players = [
        {"account_id": int(p.get("account_id") or 0), "team": int(p.get("team") or 0), "hero_id": int(p.get("hero_id") or 0)}
        for p in raw.get("players") or []
    ]
    return ActiveMatch(
        match_id=str(raw["match_id"]),
        start_time=start,
        game_mode=int(raw.get("game_mode") or 0),
        match_mode=int(raw.get("match_mode") or 0),
        region=str(raw.get("region_mode_parsed") or ""),
        match_score=int(raw.get("match_score") or 0),
        spectators=state.spectators,
        players=players,
        state=state,
    )


class DeadlockApiError(Exception):
    pass


class DeadlockApi:
    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self._client = httpx.Client(base_url=base_url, timeout=timeout_s, headers={"Accept": "application/json"})

    def active_matches(self, account_id: int | None = None) -> list[ActiveMatch]:
        """Top ~200 live matches (the in-game Watch tab), or the live match of one player."""
        params = {"account_id": str(account_id)} if account_id is not None else None
        try:
            res = self._client.get("/v1/matches/active", params=params)
            res.raise_for_status()
            body = res.json()
        except (httpx.HTTPError, ValueError) as e:
            raise DeadlockApiError(str(e)) from e
        if not isinstance(body, list):
            raise DeadlockApiError("unexpected response shape")
        now = time.time()
        return [parse_active_match(m, now) for m in body if isinstance(m, dict) and "match_id" in m]

    def close(self) -> None:
        self._client.close()
