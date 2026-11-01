"""Watcher: polls live Deadlock matches and publishes a normalized, append-only event stream.

It knows nothing about odds, users or money (High-Level Design: "The Eyes"). Responsibilities:

* keep a rolling candidate pool of live Normal-mode matches (best rank first, joined early);
* diff consecutive snapshots into events (objective destroyed, net-worth swing, ended);
* follow a match that drops out of the top-200 list via the player lookup, and emit ``match.ended``
  once it is gone for good;
* publish a heartbeat so the core can show fleet health and suspend stale matches;
* prefer the live broadcast state the Steam bot publishes (``live:frame:{id}``, about 20 s behind the game) over the
  live list (2-4 minutes old) for matches that have one, so odds react to what viewers of the live map see;
* publish the live directory (every live match with names, ranks and heroes) for the live matches page.

Run: ``python -m naebka_live.watcher``
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, cast

import httpx
import redis

from naebka_live.deadlock_api import (
    GAME_MODE_NORMAL,
    ActiveMatch,
    DeadlockApi,
    DeadlockApiError,
    PlayerLookupUnavailable,
    parse_active_match,
)
from naebka_live.directory import DIRECTORY_KEY, Assets, Enricher, build_directory
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
#: A live frame older than this means the broadcast feed stopped; fall back to the live list.
LIVE_FRESH_S = 15.0
#: Quiet snapshots are published at most this often (live frames arrive twice a second).
SNAPSHOT_EVERY_S = 10.0
#: How often tracked matches are re-read from their live frames between list polls.
LIVE_TICK_S = 2.0


def _popcount(mask: int) -> int:
    return bin(mask & 0xFFFFFFFF).count("1")


def standing_in_frame(frame: dict[str, Any]) -> tuple[int, int] | None:
    """Objectives standing per team in a frame (guardians, walkers, base guardians, patrons; not the mid-boss)."""
    objectives = frame.get("objectives")
    if not isinstance(objectives, list):
        return None
    counts = [0, 0]
    for o in objectives:
        if isinstance(o, dict) and o.get("kind") != "midboss" and o.get("team") in (0, 1):
            counts[int(o["team"])] += 1
    return counts[0], counts[1]


def state_from_frame(frame: dict[str, Any], previous: MatchState,
                     previous_standing: tuple[int, int] | None = None) -> MatchState:
    """A live map frame (deadlock-bot) as the normalized state, on the same scale as the live list.

    Valve's objective bitmasks are exact, but broadcasts don't carry them. So the live list's count stays the
    baseline and every objective that disappears from the broadcast since the previous frame is taken off it:
    objectives never come back, and shrines and the core (which the frame doesn't list) only fall last.
    """
    masks = frame.get("objectives_mask")
    if isinstance(masks, list) and len(masks) == 2:
        mask0, mask1 = int(masks[0]), int(masks[1])
        alive = (_popcount(mask0), _popcount(mask1))
    else:
        mask0, mask1 = previous.objectives_mask
        alive = previous.objectives_alive
        standing = standing_in_frame(frame)
        if standing is not None and previous_standing is not None:
            alive = (
                max(0, alive[0] - max(0, previous_standing[0] - standing[0])),
                max(0, alive[1] - max(0, previous_standing[1] - standing[1])),
            )
    nw = frame.get("net_worth")
    game_time = frame.get("game_time_s")
    winner = frame.get("winning_team")
    return MatchState(
        elapsed_s=int(game_time) if isinstance(game_time, (int, float)) else previous.elapsed_s,
        net_worth=(int(nw[0]), int(nw[1])) if isinstance(nw, list) and len(nw) == 2 else previous.net_worth,
        objectives_alive=alive,
        objectives_mask=(mask0, mask1),
        spectators=previous.spectators,
        winning_team=int(winner) if winner is not None else None,
    )


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
    #: "list" (deadlock-api / bot live list) or "live" (the broadcast feed).
    source: str = "list"
    live_tick: int = -1
    #: Objectives per team in the last applied frame, to count the ones that fell since.
    live_standing: tuple[int, int] | None = None
    snapshot_at: float = 0.0


class Watcher:
    def __init__(self, api: DeadlockApi, bus: redis.Redis, max_tracked: int,
                 enricher: Enricher | None = None, assets: Assets | None = None) -> None:
        self.api = api
        self.bus = bus
        self.max_tracked = max_tracked
        self.enricher = enricher
        self.assets = assets
        self.tracked: dict[str, Tracked] = {}
        self.api_failures = 0

    def publish(self, event: MatchEvent) -> None:
        self.bus.publish(MATCH_EVENTS_CHANNEL, event.to_json())
        if event.type != "match.snapshot":
            log.info("%s %s %s", event.type, event.match_id, {k: v for k, v in event.data.items() if k != "state"})

    def poll_once(self) -> None:
        try:
            raw = self.api.active_matches_raw()
            self.api_failures = 0
        except DeadlockApiError as e:
            self.api_failures += 1
            log.warning("Deadlock API failed (%d in a row): %s", self.api_failures, e)
            if self.api_failures == 3:
                for match_id, t in self.tracked.items():
                    self.publish(MatchEvent("match.stale", match_id, {"reason": "API_UNAVAILABLE"}))
                    t.stale_sent = True
            return

        wall = time.time()
        active = [parse_active_match(m, wall) for m in raw]
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
        self._publish_directory(raw)

    def _publish_directory(self, raw: list[dict[str, Any]]) -> None:
        if self.enricher is None:
            return
        try:
            ids = [int(p.get("account_id") or 0) for m in raw for p in m.get("players") or []]
            info = self.enricher.lookup(ids)
            directory = build_directory(raw, info, set(self.tracked), self.api.last_source, time.time())
            self.bus.set(DIRECTORY_KEY, json.dumps(directory), ex=120)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            log.warning("live directory not updated: %s", e)

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

    def _live_frame(self, match_id: str) -> dict[str, Any] | None:
        """The latest broadcast frame of a match, if the bot's feed for it is running."""
        raw = cast(bytes | None, self.bus.get(f"live:frame:{match_id}"))
        if raw is None:
            return None
        try:
            frame = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(frame, dict) or time.time() - float(frame.get("received_at") or 0) > LIVE_FRESH_S:
            return None
        return frame

    def live_tick(self) -> None:
        """Between list polls: apply new broadcast frames of tracked matches."""
        for match_id in list(self.tracked):
            t = self.tracked[match_id]
            frame = self._live_frame(match_id)
            if frame is None or int(frame.get("tick") or 0) <= t.live_tick:
                continue
            t.live_tick = int(frame.get("tick") or 0)
            t.missing_polls = 0
            self._apply_frame(match_id, frame)

    def _apply_frame(self, match_id: str, frame: dict[str, Any]) -> None:
        t = self.tracked[match_id]
        # The first frame (or the first after the list was used) only sets the objective baseline.
        previous_standing = t.live_standing if t.source == "live" else None
        state = state_from_frame(frame, t.state, previous_standing)
        t.live_standing = standing_in_frame(frame)
        self._apply(match_id, state, "live")

    def _apply(self, match_id: str, state: MatchState, source: str) -> None:
        t = self.tracked[match_id]
        if t.source == "live" and source == "list":
            # The broadcast feed stopped and the live list is older than what we had: start again from it, without
            # turning the difference into events (it would look like objectives coming back).
            log.info("%s: live feed stopped, back to the live list", match_id)
            t.source, t.state = source, state
            self.publish(MatchEvent("match.snapshot", match_id, state_payload(state)))
            t.snapshot_at = time.monotonic()
            return
        if t.source != source:
            log.info("%s: now using the live broadcast", match_id)
        t.source = source
        t.stale_sent = False
        now = time.monotonic()
        for e in diff_events(match_id, t.state, state):
            if e.type == "match.snapshot":
                if now - t.snapshot_at < SNAPSHOT_EVERY_S:
                    continue
                t.snapshot_at = now
            self.publish(e)
        t.state = state
        if state.winning_team is not None:
            del self.tracked[match_id]

    def _update(self, match_id: str, seen: ActiveMatch | None) -> None:
        t = self.tracked[match_id]
        frame = self._live_frame(match_id)
        if frame is not None:
            # The broadcast is fresher than the list; the list only keeps the match "seen".
            t.missing_polls = 0
            if int(frame.get("tick") or 0) > t.live_tick:
                t.live_tick = int(frame.get("tick") or 0)
                self._apply_frame(match_id, frame)
            return
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
        self._apply(match_id, seen.state, "list")

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
        # The Steam bot follows the broadcasts of these matches (deadlock-bot/src/feeds.rs).
        self.bus.set("watcher:tracked", json.dumps(tracked), ex=60)
        if self.assets is not None:
            self.assets.maybe_refresh()
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
    base_url = os.environ.get("DEADLOCK_API_BASE_URL", "https://api.deadlock-api.com")
    watcher = Watcher(api, bus, int(os.environ.get("WATCHER_MAX_TRACKED", "8")),
                      enricher=Enricher(bus, base_url), assets=Assets(bus, base_url))
    log.info("Watcher started (poll every %.0fs, max %d matches)", poll_s, watcher.max_tracked)
    next_poll = 0.0
    while True:
        started = time.monotonic()
        try:
            if started >= next_poll:
                next_poll = started + poll_s
                watcher.poll_once()
                watcher.heartbeat()
            else:
                watcher.live_tick()
        except redis.RedisError as e:
            log.error("Redis error: %s", e)
        time.sleep(max(0.2, min(LIVE_TICK_S, next_poll - time.monotonic())))


if __name__ == "__main__":
    main()
