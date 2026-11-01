"""Client for live Deadlock match lists. Only the watcher uses it.

It asks the public Deadlock API (https://api.deadlock-api.com) first. When the API answers "too many requests" (429)
or "service unavailable" (503) it is skipped for as long as its ``Retry-After`` header says, and the team's Steam bot
(``deadlock-bot serve``, same JSON) answers instead. The bot can't look up the live match of one player
(``account_id``); while only the bot can be asked, those lookups raise :class:`PlayerLookupUnavailable`.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from naebka_live.events import MatchState

log = logging.getLogger("deadlock_api")

GAME_MODE_NORMAL = 1

API_SOURCE = "deadlock-api"
BOT_SOURCE = "deadlock-bot"

#: How long a source is skipped after a 429/503 without a usable Retry-After header.
DEFAULT_RETRY_AFTER_S = 60.0
MAX_RETRY_AFTER_S = 900.0


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


class PlayerLookupUnavailable(DeadlockApiError):
    """No source can look up a player's live match right now (the API is skipped or failed; the bot can't)."""


def retry_after_seconds(res: httpx.Response) -> float:
    value = res.headers.get("Retry-After", "")
    try:
        seconds = float(value)
    except ValueError:
        return DEFAULT_RETRY_AFTER_S
    return min(MAX_RETRY_AFTER_S, max(1.0, seconds))


@dataclass
class _Source:
    name: str
    client: httpx.Client
    player_lookup: bool
    skipped_until: float = 0.0


class DeadlockApi:
    def __init__(
        self,
        base_url: str,
        timeout_s: float = 10.0,
        *,
        bot_url: str | None = None,
        bot_token: str | None = None,
        bot_timeout_s: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
        transport: httpx.BaseTransport | None = None,
        bot_transport: httpx.BaseTransport | None = None,
    ) -> None:
        headers = {"Accept": "application/json"}
        self._clock = clock
        self._sources = [
            _Source(API_SOURCE, httpx.Client(base_url=base_url, timeout=timeout_s, headers=headers, transport=transport), True)
        ]
        if bot_url:
            bot_headers = dict(headers)
            if bot_token:
                bot_headers["Authorization"] = f"Bearer {bot_token}"
            client = httpx.Client(base_url=bot_url, timeout=bot_timeout_s, headers=bot_headers, transport=bot_transport)
            self._sources.append(_Source(BOT_SOURCE, client, False))
        #: The source that answered last ("deadlock-api" or "deadlock-bot"); None before the first answer.
        self.last_source: str | None = None

    def active_matches(self, account_id: int | None = None) -> list[ActiveMatch]:
        """Top ~200 live matches (the in-game Watch tab), or the live match of one player."""
        wall = time.time()
        return [parse_active_match(m, wall) for m in self.active_matches_raw(account_id)]

    def active_matches_raw(self, account_id: int | None = None) -> list[dict[str, Any]]:
        """The same, as deadlock-api's JSON objects (every field, for the live directory)."""
        params = {"account_id": str(account_id)} if account_id is not None else None
        problems: list[str] = []
        for source in self._sources:
            if account_id is not None and not source.player_lookup:
                continue
            now = self._clock()
            if now < source.skipped_until:
                problems.append(f"{source.name} is rate limited for {source.skipped_until - now:.0f}s more")
                continue
            try:
                res = source.client.get("/v1/matches/active", params=params)
                if res.status_code in (429, 503):
                    wait = retry_after_seconds(res)
                    source.skipped_until = now + wait
                    log.warning("%s answered %d: skipping it for %.0fs", source.name, res.status_code, wait)
                    problems.append(f"{source.name} answered {res.status_code}")
                    continue
                res.raise_for_status()
                body = res.json()
            except (httpx.HTTPError, ValueError) as e:
                problems.append(f"{source.name}: {e}")
                continue
            if not isinstance(body, list):
                problems.append(f"{source.name}: unexpected response shape")
                continue
            self._answered_by(source.name)
            return [m for m in body if isinstance(m, dict) and "match_id" in m]

        message = "; ".join(problems) or "no source configured"
        if account_id is not None:
            raise PlayerLookupUnavailable(message)
        raise DeadlockApiError(message)

    def _answered_by(self, name: str) -> None:
        if name != self.last_source:
            if self.last_source is not None:
                log.warning("live matches now come from %s", name)
            self.last_source = name

    def close(self) -> None:
        for source in self._sources:
            source.client.close()
