"""Odds Engine: subscribes to the watcher's event stream and publishes prices.

Suspend-then-reprice: the core suspends markets as soon as a state-changing event arrives; this engine
waits a short cooling-off (``REOPEN_DELAY_S``) after such an event before publishing the new price that
reopens them, so bettors with a faster feed cannot exploit the transition (Risk #1). Routine snapshots are
only republished when a price moves by at least ``MIN_RELATIVE_MOVE``.

Run: ``python -m naebka_live.odds_engine``
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, cast

import redis

from naebka_live.events import (
    MATCH_EVENTS_CHANNEL,
    ODDS_UPDATES_CHANNEL,
    STATE_CHANGING,
    MatchState,
    StateDict,
)
from naebka_live.odds import MarketPrice, price_match

log = logging.getLogger("odds-engine")

REOPEN_DELAY_S = 5.0
#: A price is only republished when it moves by at least this share (2.50 -> 2.55), so noise does not
#: churn in-flight bets with PRICE_CHANGED.
MIN_RELATIVE_MOVE = Decimal("0.02")
#: Prices are republished at least this often, so a consumer that missed an update (e.g. the core was
#: restarting) recovers on its own instead of leaving markets suspended.
REFRESH_S = 30.0


@dataclass
class MatchBook:
    state: MatchState
    published: list[MarketPrice] | None = None
    reopen_at: float | None = None
    based_on_event: str | None = None
    published_at: float = 0.0


def needs_publish(old: list[MarketPrice] | None, new: list[MarketPrice]) -> bool:
    """True if any price moved enough, a market closed, or nothing was published yet."""
    if old is None:
        return True
    old_by_type = {p.market_type: p for p in old}
    for price in new:
        before = old_by_type.get(price.market_type)
        if before is None or before.close != price.close:
            return True
        for key, odds in price.odds.items():
            previous = before.odds.get(key)
            if previous is None or abs(odds - previous) >= previous * MIN_RELATIVE_MOVE:
                return True
    return False


@dataclass
class OddsEngine:
    bus: redis.Redis
    margin: float
    books: dict[str, MatchBook] = field(default_factory=dict)

    def on_event(self, event: dict[str, Any], now: float) -> None:
        etype = str(event.get("type"))
        match_id = str(event.get("match_id"))
        data = cast(dict[str, Any], event.get("data") or {})
        if etype in ("match.ended", "match.stale"):
            self.books.pop(match_id, None)
            return
        raw_state = data.get("state")
        if not isinstance(raw_state, dict) or "net_worth" not in raw_state:
            return
        state = MatchState.from_dict(cast(StateDict, raw_state))
        book = self.books.get(match_id)
        if book is None:
            book = self.books[match_id] = MatchBook(state)
        book.state = state
        if etype in STATE_CHANGING:
            # The core has suspended the markets; price again only after the cooling-off.
            book.published = None
            book.reopen_at = now + REOPEN_DELAY_S
            book.based_on_event = str(event.get("event_id"))
        elif book.reopen_at is None:
            self._maybe_publish(match_id, book, str(event.get("event_id")), now)

    def tick(self, now: float) -> None:
        for match_id, book in self.books.items():
            if book.reopen_at is not None and now >= book.reopen_at:
                book.reopen_at = None
                self._maybe_publish(match_id, book, book.based_on_event, now)
            elif book.reopen_at is None and now - book.published_at >= REFRESH_S:
                self._maybe_publish(match_id, book, None, now, force=True)

    def _maybe_publish(self, match_id: str, book: MatchBook, event_id: str | None, now: float,
                       force: bool = False) -> None:
        prices = price_match(book.state, self.margin)
        if not needs_publish(book.published, prices):
            if not force or book.published is None:
                return
            prices = book.published  # periodic refresh: resend the same prices, so nothing reprices
        book.published = prices
        book.published_at = now
        message = {
            "match_id": match_id,
            "based_on_event_id": event_id,
            "ts": time.time(),
            "markets": [p.to_json() for p in prices],
        }
        self.bus.publish(ODDS_UPDATES_CHANNEL, json.dumps(message))
        log.info("priced %s: %s", match_id, {p.market_type: {k: str(v) for k, v in p.odds.items()} for p in prices})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bus = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:56379/0"))
    engine = OddsEngine(bus, float(os.environ.get("ODDS_MARGIN", "0.06")))
    pubsub = bus.pubsub(ignore_subscribe_messages=True)  # type: ignore[no-untyped-call]
    pubsub.subscribe(MATCH_EVENTS_CHANNEL)
    log.info("Odds engine started (margin %.2f)", engine.margin)
    last_heartbeat = 0.0
    while True:
        message = pubsub.get_message(timeout=0.5)
        now = time.monotonic()
        if message and message.get("type") == "message":
            try:
                engine.on_event(json.loads(message["data"]), now)
            except (ValueError, KeyError, TypeError) as e:
                log.warning("bad event skipped: %s", e)
        engine.tick(now)
        if now - last_heartbeat > 10:
            bus.set("odds-engine:heartbeat", str(int(time.time())), ex=60)
            last_heartbeat = now


if __name__ == "__main__":
    main()
