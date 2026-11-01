"""Normalized, game-agnostic event taxonomy shared by the watcher, the odds engine and the core.

Everything Deadlock-specific is translated into these shapes inside the watcher, so an API change
only ever means patching the watcher (High-Level Design §3).

Wire format on Redis channel ``naebka:match-events``::

    {"event_id": str, "type": EventType, "match_id": str, "ts": ISO-8601, "data": {..., "state": MatchState}}
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Literal, TypedDict

MATCH_EVENTS_CHANNEL = "naebka:match-events"
ODDS_UPDATES_CHANNEL = "naebka:odds-updates"

EventType = Literal[
    "match.discovered",
    "match.snapshot",
    "objective.destroyed",
    "networth.swing",
    "match.stale",
    "match.ended",
    "watcher.heartbeat",
]

#: Events after which existing prices are no longer valid: the core suspends markets first.
STATE_CHANGING: frozenset[str] = frozenset(
    {"objective.destroyed", "networth.swing", "match.stale", "match.ended"}
)


class StateDict(TypedDict):
    elapsed_s: int
    net_worth: list[int]
    objectives_alive: list[int]
    objectives_mask: list[int]
    spectators: int
    winning_team: int | None


@dataclass(frozen=True)
class MatchState:
    """Normalized live state of a two-team match (team index 0 and 1)."""

    elapsed_s: int
    net_worth: tuple[int, int]
    objectives_alive: tuple[int, int]
    objectives_mask: tuple[int, int]
    spectators: int = 0
    winning_team: int | None = None

    def to_dict(self) -> StateDict:
        return {
            "elapsed_s": self.elapsed_s,
            "net_worth": list(self.net_worth),
            "objectives_alive": list(self.objectives_alive),
            "objectives_mask": list(self.objectives_mask),
            "spectators": self.spectators,
            "winning_team": self.winning_team,
        }

    @staticmethod
    def from_dict(d: StateDict) -> MatchState:
        nw = d["net_worth"]
        alive = d["objectives_alive"]
        mask = d["objectives_mask"]
        return MatchState(
            elapsed_s=int(d["elapsed_s"]),
            net_worth=(int(nw[0]), int(nw[1])),
            objectives_alive=(int(alive[0]), int(alive[1])),
            objectives_mask=(int(mask[0]), int(mask[1])),
            spectators=int(d.get("spectators", 0)),
            winning_team=d.get("winning_team"),
        )


JsonValue = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


@dataclass(frozen=True)
class MatchEvent:
    type: EventType
    match_id: str
    data: dict[str, JsonValue]
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))

    def to_json(self) -> str:
        return json.dumps(asdict(self))


def state_payload(state: MatchState, **extra: JsonValue) -> dict[str, JsonValue]:
    payload: dict[str, JsonValue] = dict(extra)
    payload["state"] = dict(state.to_dict())  # type: ignore[arg-type]
    return payload
