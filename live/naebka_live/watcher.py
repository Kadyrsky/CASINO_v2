"""Watcher: polls live Deadlock matches and publishes a normalized, append-only event stream.

It knows nothing about odds, users or money (High-Level Design: "The Eyes"). Responsibilities:

* keep a rolling candidate pool of live Normal-mode matches (best rank first, joined early);
* diff consecutive snapshots into events (objective destroyed, net-worth swing, ended);
* follow a match that drops out of the top-200 list via the player lookup, and emit ``match.ended``
  once it is gone for good;
* publish a heartbeat so the core can show fleet health and suspend stale matches.

Run: ``python -m naebka_live.watcher``
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

import redis

from naebka_live.deadlock_api import (
    GAME_MODE_NORMAL,
    ActiveMatch,
    DeadlockApi,
    DeadlockApiError,
    PlayerLookupUnavailable,
)
from naebka_live.events import MATCH_EVENTS_CHANNEL, JsonValue, MatchEvent, MatchState, state_payload

log = logging.getLogger("watcher")

#: Only join matches early enough that betting is meaningful.
MAX_JOIN_ELAPSED_S = 8 * 60
#: A net-worth lead change smaller than this is noise, not a swing.
SWING_MIN_LEAD = 2_000
#: A lead that moves by this share of total net worth in one poll is a swing.
SWING_SHARE = 0.06
#: Polls a match may be missing (and not found via player lookup) before it counts as ended.
MISSING_POLLS_BEFORE_END = 3
#: The same while the player lookup can't run (only the Steam bot answers, and it has no lookup). A match that just
#: dropped out of the top 200 then looks the same as one that ended, so wait longer before calling it ended.
MISSING_POLLS_WHILE_BLIND = 12
#: Tracked matches are re-announced this often, so a consumer that missed the first announcement
#: (e.g. the core was restarting) still picks the match up. The core treats repeats as no-ops.
REANNOUNCE_S = 60.0


def diff_events(match_id: str, prev: MatchState, cur: MatchState) -> list[MatchEvent]:
    """Turn two consecutive snapshots into normalized events. Pure function — unit tested."""
    events: list[MatchEvent] = []
    for team in (0, 1):
        lost = prev.objectives_alive[team] - cur.objectives_alive[team]
        if lost > 0:
            events.append(
                MatchEvent("objective.destroyed", match_id, state_payload(cur, team=team, count=lost))
            )

    prev_lead = prev.net_worth[0] - prev.net_worth[1]
    cur_lead = cur.net_worth[0] - cur.net_worth[1]
    total = max(1, sum(cur.net_worth))
    leader_changed = (prev_lead > 0) != (cur_lead > 0) and abs(cur_lead) >= SWING_MIN_LEAD
    big_move = abs(cur_lead - prev_lead) / total >= SWING_SHARE and abs(cur_lead - prev_lead) >= SWING_MIN_LEAD
    if leader_changed or big_move:
        leader = 0 if cur_lead > 0 else 1
        events.append(MatchEvent("networth.swing", match_id, state_payload(cur, leader=leader, lead=abs(cur_lead))))

    if cur.winning_team is not None and prev.winning_team is None:
        events.append(MatchEvent("match.ended", match_id, state_payload(cur, winning_team=cur.winning_team)))
    elif not events:
        events.append(MatchEvent("match.snapshot", match_id, state_payload(cur)))
    return events


def pick_candidates(active: list[ActiveMatch], tracked: set[str], slots: int) -> list[ActiveMatch]:
    """Rolling candidate pool: fresh Normal-mode matches, highest rank and audience first."""
    fresh = [
        m
        for m in active
        if m.game_mode == GAME_MODE_NORMAL
        and m.state.winning_team is None
        and m.state.elapsed_s <= MAX_JOIN_ELAPSED_S
        and m.match_id not in tracked
        and len(m.players) >= 2
    ]
    fresh.sort(key=lambda m: (m.match_score, m.spectators), reverse=True)
    return fresh[: max(0, slots)]


@dataclass
class Tracked:
    match: ActiveMatch
    state: MatchState
    missing_polls: int = 0
    stale_sent: bool = False
    account_ids: list[int] = field(default_factory=list)
    announced_at: float = 0.0


class Watcher:
    def __init__(self, api: DeadlockApi, bus: redis.Redis, max_tracked: int) -> None:
        self.api = api
        self.bus = bus
        self.max_tracked = max_tracked
        self.tracked: dict[str, Tracked] = {}
        self.api_failures = 0

    def publish(self, event: MatchEvent) -> None:
        self.bus.publish(MATCH_EVENTS_CHANNEL, event.to_json())
        if event.type != "match.snapshot":
            log.info("%s %s %s", event.type, event.match_id, {k: v for k, v in event.data.items() if k != "state"})

    def poll_once(self) -> None:
        try:
            active = self.api.active_matches()
            self.api_failures = 0
        except DeadlockApiError as e:
            self.api_failures += 1
            log.warning("Deadlock API failed (%d in a row): %s", self.api_failures, e)
            if self.api_failures == 3:
                for match_id, t in self.tracked.items():
                    self.publish(MatchEvent("match.stale", match_id, {"reason": "API_UNAVAILABLE"}))
                    t.stale_sent = True
            return

        by_id = {m.match_id: m for m in active}
        for match_id in list(self.tracked):
            self._update(match_id, by_id.get(match_id))

        for m in pick_candidates(active, set(self.tracked), self.max_tracked - len(self.tracked)):
            self.tracked[m.match_id] = Tracked(m, m.state, account_ids=[p["account_id"] for p in m.players])
        now = time.monotonic()
        for t in self.tracked.values():
            if now - t.announced_at >= REANNOUNCE_S:
                self._announce(t)
                t.announced_at = now

    def _announce(self, t: Tracked) -> None:
        m = t.match
        data: dict[str, JsonValue] = state_payload(
            t.state,
            start_time=m.start_time,
            game_mode=m.game_mode,
            match_mode=m.match_mode,
            region=m.region,
            match_score=m.match_score,
            players=[dict(p) for p in m.players],
        )
        self.publish(MatchEvent("match.discovered", m.match_id, data))

    def _update(self, match_id: str, seen: ActiveMatch | None) -> None:
        t = self.tracked[match_id]
        blind = False
        if seen is None:
            try:
                seen = self._lookup_by_player(t)
            except PlayerLookupUnavailable:
                blind = True
        if seen is None:
            t.missing_polls += 1
            if t.missing_polls >= (MISSING_POLLS_WHILE_BLIND if blind else MISSING_POLLS_BEFORE_END):
                # Gone from the live list and no player is in it any more: the match is over.
                # The winner is unknown from the stream; settlement uses the official report.
                payload = state_payload(t.state, winning_team=t.state.winning_team)
                self.publish(MatchEvent("match.ended", match_id, payload))
                del self.tracked[match_id]
            return
        t.missing_polls = 0
        events = diff_events(match_id, t.state, seen.state)
        if t.stale_sent:
            t.stale_sent = False
        for e in events:
            self.publish(e)
        t.state = seen.state
        if seen.state.winning_team is not None:
            del self.tracked[match_id]

    def _lookup_by_player(self, t: Tracked) -> ActiveMatch | None:
        """The tracked match found through one of its players, or None. Raises PlayerLookupUnavailable."""
        for account_id in t.account_ids[:2]:
            for m in self.api.active_matches(account_id=account_id):
                if m.match_id == t.match.match_id:
                    return m
        return None

    def heartbeat(self) -> None:
        tracked: list[JsonValue] = list(self.tracked)
        self.bus.set("watcher:heartbeat", MatchEvent("watcher.heartbeat", "", {"tracked": tracked}).ts, ex=60)
        # Shown on the admin dashboard: is the watcher on deadlock-api or on the Steam bot?
        if self.api.last_source:
            self.bus.set("watcher:source", self.api.last_source, ex=60)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    api = DeadlockApi(
        os.environ.get("DEADLOCK_API_BASE_URL", "https://api.deadlock-api.com"),
        bot_url=os.environ.get("DEADLOCK_BOT_URL") or None,
        bot_token=os.environ.get("DEADLOCK_BOT_TOKEN") or None,
    )
    bus = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:56379/0"))
    poll_s = float(os.environ.get("WATCHER_POLL_SECONDS", "10"))
    watcher = Watcher(api, bus, int(os.environ.get("WATCHER_MAX_TRACKED", "8")))
    log.info("Watcher started (poll every %.0fs, max %d matches)", poll_s, watcher.max_tracked)
    while True:
        started = time.monotonic()
        try:
            watcher.poll_once()
            watcher.heartbeat()
        except redis.RedisError as e:
            log.error("Redis error: %s", e)
        time.sleep(max(0.5, poll_s - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
