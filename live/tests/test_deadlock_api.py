"""deadlock-api first; the Steam bot (deadlock-bot serve) while the API says "too many requests" or is down."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from naebka_live.deadlock_api import (
    API_SOURCE,
    BOT_SOURCE,
    DeadlockApi,
    DeadlockApiError,
    PlayerLookupUnavailable,
)

MATCH = {"match_id": 7, "start_time": 1, "game_mode": 1, "players": [{"account_id": 1, "team": 0, "hero_id": 2}]}


class Stub:
    """Answers from a script (then 200 with one match) and records requests."""

    def __init__(self) -> None:
        self.script: list[httpx.Response] = []
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.script:
            return self.script.pop(0)
        return httpx.Response(200, content=json.dumps([MATCH]))

    def then(self, status: int, headers: dict[str, str] | None = None, body: Any = None) -> Stub:
        self.script.append(httpx.Response(status, headers=headers, content=json.dumps(body) if body is not None else b""))
        return self


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(api: Stub, bot: Stub | None, clock: Clock) -> DeadlockApi:
    return DeadlockApi(
        "http://api.test",
        bot_url="http://bot.test" if bot else None,
        bot_token="secret",
        clock=clock,
        transport=httpx.MockTransport(api.handler),
        bot_transport=httpx.MockTransport(bot.handler) if bot else None,
    )


def test_api_answers_and_bot_is_not_asked() -> None:
    api, bot = Stub(), Stub()
    client = make(api, bot, Clock())
    assert [m.match_id for m in client.active_matches()] == ["7"]
    assert client.last_source == API_SOURCE
    assert bot.requests == []


def test_too_many_requests_switches_to_the_bot_for_retry_after() -> None:
    api, bot, clock = Stub().then(429, {"Retry-After": "120"}), Stub(), Clock()
    client = make(api, bot, clock)

    assert [m.match_id for m in client.active_matches()] == ["7"]
    assert client.last_source == BOT_SOURCE
    assert bot.requests[0].headers["Authorization"] == "Bearer secret"

    clock.now += 60  # still inside Retry-After: the API is not asked
    client.active_matches()
    assert len(api.requests) == 1 and len(bot.requests) == 2

    clock.now += 61  # Retry-After is over: back to the API
    client.active_matches()
    assert len(api.requests) == 2
    assert client.last_source == API_SOURCE


def test_server_error_falls_back_without_skipping_the_api_next_time() -> None:
    api, bot = Stub().then(502), Stub()
    client = make(api, bot, Clock())
    client.active_matches()
    assert client.last_source == BOT_SOURCE
    client.active_matches()
    assert client.last_source == API_SOURCE


def test_player_lookup_is_unavailable_while_the_api_is_skipped() -> None:
    api, bot = Stub().then(429), Stub()
    client = make(api, bot, Clock())
    client.active_matches()
    with pytest.raises(PlayerLookupUnavailable):
        client.active_matches(account_id=1)
    assert all("account_id" not in str(r.url) for r in bot.requests)


def test_both_down_is_an_error_naming_both() -> None:
    api, bot = Stub().then(429), Stub().then(503)
    with pytest.raises(DeadlockApiError) as err:
        make(api, bot, Clock()).active_matches()
    assert "deadlock-api" in str(err.value) and "deadlock-bot" in str(err.value)


def test_without_a_bot_rate_limit_is_an_error() -> None:
    with pytest.raises(DeadlockApiError):
        make(Stub().then(429), None, Clock()).active_matches()
