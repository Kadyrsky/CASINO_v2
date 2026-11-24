"""Live directory: every match in the in-game Watch tab with each player's Steam name, rank and hero, for the
website's live matches page. The watcher writes it to Redis after every live-list poll:

* ``live:directory`` - the enriched list (see :func:`build_directory`), read by the core at ``GET /api/live/directory``;
* ``live:assets`` - hero, rank and item names and images and the map, refreshed every few hours, read at
  ``GET /api/live/assets``.

Names and ranks come from deadlock-api in batches of up to 1000 accounts and are cached in Redis
(``naebka:pname:{id}`` for a day, ``naebka:prank:{id}`` for an hour), so a full list costs a few requests an hour.
The rank endpoint allows 20 requests a minute per IP; this asks at most once every 5 s.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from collections.abc import Callable, Iterable
from typing import Any, cast

import httpx
import redis

log = logging.getLogger("directory")

DIRECTORY_KEY = "live:directory"
ASSETS_KEY = "live:assets"
NAME_TTL_S = 24 * 3600
#: Players deadlock-api has no profile for are asked again after this long.
UNKNOWN_TTL_S = 6 * 3600
RANK_TTL_S = 3600
RANK_CALL_GAP_S = 5.0
BATCH = 1000
ASSETS_EVERY_S = 6 * 3600

MATCH_MODES = {1: "unranked", 2: "private", 3: "bots", 4: "ranked", 8: "placement"}
GAME_MODES = {1: "normal", 4: "street_brawl"}


def badge_index(badge: int) -> int | None:
    """Badge 105 = tier 10, subrank 5. As one linear index (tier * 6 + subrank - 1), so badges can be averaged."""
    tier, sub = divmod(badge, 10)
    if tier <= 0 or not 1 <= sub <= 6:
        return None
    return tier * 6 + sub - 1


def badge_from_index(index: float) -> int:
    tier, sub = divmod(round(index), 6)
    return tier * 10 + sub + 1


def average_badge(badges: Iterable[int | None]) -> int | None:
    idx = [i for b in badges if b for i in [badge_index(b)] if i is not None]
    return badge_from_index(sum(idx) / len(idx)) if idx else None


def _popcount(mask: int) -> int:
    return bin(mask & 0xFFFFFFFF).count("1")


def build_directory(
    raw: list[dict[str, Any]], players: dict[int, dict[str, Any]], tracked: set[str], source: str | None, now: float
) -> dict[str, Any]:
    """The JSON the live matches page shows. ``players`` maps account id to {name, avatar, badge}."""
    matches: list[dict[str, Any]] = []
    spread: Counter[int] = Counter()
    for m in raw:
        roster = []
        for p in m.get("players") or []:
            account = int(p.get("account_id") or 0)
            info = players.get(account, {})
            roster.append({
                "account_id": account,
                "team": int(p.get("team") or 0),
                "hero_id": int(p.get("hero_id") or 0),
                "name": info.get("name"),
                "avatar": info.get("avatar"),
                "badge": info.get("badge") or None,
            })
        team_badges = [average_badge(p["badge"] for p in roster if p["team"] == team) for team in (0, 1)]
        match_badge = average_badge(p["badge"] for p in roster)
        if match_badge:
            spread[match_badge // 10] += 1
        start = int(m.get("start_time") or now)
        masks = (int(m.get("objectives_mask_team0") or 0), int(m.get("objectives_mask_team1") or 0))
        mode = int(m.get("match_mode") or 0)
        game_mode = int(m.get("game_mode") or 0)
        matches.append({
            "match_id": str(m["match_id"]),
            "start_time": start,
            "elapsed_s": max(0, int(now) - start),
            "match_mode": MATCH_MODES.get(mode, "other"),
            "game_mode": GAME_MODES.get(game_mode, "other"),
            "region": str(m.get("region_mode_parsed") or "") or None,
            "spectators": int(m.get("spectators") or 0),
            "match_score": int(m.get("match_score") or 0),
            "net_worth": [int(m.get("net_worth_team_0") or 0), int(m.get("net_worth_team_1") or 0)],
            "objectives_alive": [_popcount(masks[0]), _popcount(masks[1])],
            "winning_team": m.get("winning_team"),
            "team_badges": team_badges,
            "badge": match_badge,
            "tracked": str(m["match_id"]) in tracked,
            "players": roster,
        })
    return {
        "updated_at": now,
        "source": source,
        "total": len(matches),
        "rank_spread": [{"tier": tier, "matches": n} for tier, n in sorted(spread.items(), reverse=True)],
        "matches": matches,
    }


class Enricher:
    """Steam names and ranks of players, cached in Redis."""

    def __init__(self, bus: redis.Redis, base_url: str, *, clock: Callable[[], float] = time.monotonic,
                 transport: httpx.BaseTransport | None = None) -> None:
        self.bus = bus
        self.clock = clock
        self.http = httpx.Client(base_url=base_url, timeout=15.0, headers={"Accept": "application/json"},
                                 transport=transport)
        self._next_rank_call = 0.0

    def lookup(self, account_ids: Iterable[int]) -> dict[int, dict[str, Any]]:
        ids = sorted({a for a in account_ids if a > 0})
        if not ids:
            return {}
        names = self._cached("naebka:pname:", ids)
        ranks = self._cached("naebka:prank:", ids)
        self._fetch_names([a for a in ids if a not in names], names)
        if self.clock() >= self._next_rank_call:
            missing = [a for a in ids if a not in ranks]
            if missing:
                self._next_rank_call = self.clock() + RANK_CALL_GAP_S
                self._fetch_ranks(missing[:BATCH], ranks)
        out: dict[int, dict[str, Any]] = {}
        for a in ids:
            n, r = names.get(a, {}), ranks.get(a, {})
            out[a] = {"name": n.get("name"), "avatar": n.get("avatar"), "badge": r.get("badge") or None}
        return out

    def _cached(self, prefix: str, ids: list[int]) -> dict[int, dict[str, Any]]:
        out: dict[int, dict[str, Any]] = {}
        for start in range(0, len(ids), BATCH):
            chunk = ids[start:start + BATCH]
            values = cast(list[bytes | None], self.bus.mget([f"{prefix}{a}" for a in chunk]))
            for a, v in zip(chunk, values):
                if v is not None:
                    try:
                        out[a] = json.loads(v)
                    except ValueError:
                        pass
        return out

    def _store(self, prefix: str, values: dict[int, dict[str, Any]], ttl: dict[int, int]) -> None:
        pipe = self.bus.pipeline()
        for a, v in values.items():
            pipe.set(f"{prefix}{a}", json.dumps(v), ex=ttl[a])
        pipe.execute()

    def _get(self, path: str, ids: list[int]) -> list[dict[str, Any]]:
        res = self.http.get(path, params={"account_ids": ",".join(map(str, ids))})
        res.raise_for_status()
        body = res.json()
        return [x for x in body if isinstance(x, dict)] if isinstance(body, list) else []

    def _fetch_names(self, ids: list[int], into: dict[int, dict[str, Any]]) -> None:
        for start in range(0, len(ids), BATCH):
            chunk = ids[start:start + BATCH]
            try:
                rows = self._get("/v1/players/steam", chunk)
            except (httpx.HTTPError, ValueError) as e:
                log.warning("Steam names unavailable: %s", e)
                return
            found = {int(r["account_id"]): {"name": r.get("personaname"), "avatar": r.get("avatar")}
                     for r in rows if r.get("account_id") is not None}
            fresh = {a: found.get(a, {"name": None, "avatar": None}) for a in chunk}
            self._store("naebka:pname:", fresh, {a: NAME_TTL_S if a in found else UNKNOWN_TTL_S for a in chunk})
            into.update(fresh)

    def _fetch_ranks(self, ids: list[int], into: dict[int, dict[str, Any]]) -> None:
        try:
            rows = self._get("/v1/players/rank", ids)
        except (httpx.HTTPError, ValueError) as e:
            log.warning("player ranks unavailable: %s", e)
            return
        found = {int(r["account_id"]): {"badge": int(r.get("badge") or 0)} for r in rows if r.get("account_id") is not None}
        fresh = {a: found.get(a, {"badge": 0}) for a in ids}  # protected accounts are left out: no rank
        self._store("naebka:prank:", fresh, {a: RANK_TTL_S for a in ids})
        into.update(fresh)

    def close(self) -> None:
        self.http.close()


# Points per curve between two of a zipline's points.
ZIPLINE_STEPS = 4


def zipline_points(path: dict[str, Any]) -> list[list[float]]:
    """A zipline's cable as [x, y, z] points: deadlock-api's points (P0, from the origin) joined by cubic Bézier
    curves, whose handles are P2 (out of a point) and P1 (into the next). Measured on live broadcasts, heroes riding
    it hang with their feet about 100 units below these heights. Straight lines when the handles are missing."""
    def xyz(row: Any) -> list[float]:
        values = [float(v) for v in row][:3] if isinstance(row, (list, tuple)) else []
        return values + [0.0] * (3 - len(values))

    origin = xyz(path["origin"])
    p0 = [[o + v for o, v in zip(origin, xyz(r))] for r in path.get("P0_points") or []]
    into = [xyz(r) for r in path.get("P1_points") or []]
    out_of = [xyz(r) for r in path.get("P2_points") or []]
    cable = p0[:1]
    for i, (a, b) in enumerate(zip(p0, p0[1:])):
        if len(into) != len(p0) or len(out_of) != len(p0):
            cable.append(b)
            continue
        c1 = [v + h for v, h in zip(a, out_of[i])]
        c2 = [v + h for v, h in zip(b, into[i + 1])]
        for s in range(1, ZIPLINE_STEPS + 1):
            t = s / ZIPLINE_STEPS
            u = 1 - t
            cable.append([u * u * u * a[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * b[k] for k in range(3)])
    return [[round(v, 1) for v in p] for p in cable]


def compact_assets(heroes: list[Any], ranks: list[Any], items: list[Any], world: dict[str, Any]) -> dict[str, Any]:
    """Only what the website draws, keyed by id."""
    def image(images: dict[str, Any], *names: str) -> str | None:
        return next((images[n] for n in names if images.get(n)), None)

    def points(rows: Any) -> list[list[float]]:
        return [[r["position"][0], r["position"][1]] for r in rows or []
                if isinstance(r, dict) and len(r.get("position") or []) >= 2]

    raw_entities = world.get("entities")
    entities: dict[str, Any] = raw_entities if isinstance(raw_entities, dict) else {}

    return {
        "heroes": {
            str(h["id"]): {
                "name": h.get("name"),
                "icon": image(h.get("images") or {}, "icon_image_small_webp", "icon_image_small"),
                "minimap": image(h.get("images") or {}, "minimap_image_webp", "minimap_image"),
                "color": (h.get("colors") or {}).get("ui"),
            }
            for h in heroes if isinstance(h, dict) and "id" in h
        },
        "ranks": {
            str(r["tier"]): {
                "name": r.get("name"),
                "image": image(r.get("images") or {}, "large_webp", "large"),
                "color": r.get("color"),
            }
            for r in ranks if isinstance(r, dict) and "tier" in r
        },
        # Every upgrade, since a frame may name any; "shop" marks the ones the shop sells. The rest (about 80 of 250)
        # are removed items, some still under internal names and with other items' art, and Street Brawl's own.
        "items": {
            str(i["id"]): {
                "name": i.get("name"),
                "image": i.get("shop_image_small") or i.get("image"),
                "tier": i.get("item_tier"),
                "slot": i.get("item_slot_type"),
                "shop": bool(i.get("shopable")),
            }
            for i in items if isinstance(i, dict) and i.get("type") == "upgrade" and "id" in i
        },
        # Heroes' own four abilities, for the realtime map's "unlocked / upgraded an ability" events.
        "abilities": {
            str(i["id"]): {"name": i.get("name"), "image": i.get("image_webp") or i.get("image")}
            for i in items if isinstance(i, dict) and i.get("type") == "ability" and "id" in i
            and i.get("ability_type") in ("signature", "ultimate")
        },
        "map": {
            "radius": world.get("radius"),
            "image": (world.get("images") or {}).get("minimap"),
            # The ziplines, with their heights for the 3D view (the 2D map uses x and y).
            "lanes": [
                {"color": z.get("color"), "points": zipline_points(z)}
                for z in world.get("zipline_paths") or [] if isinstance(z, dict) and z.get("origin")
            ],
            # Neutral camps (weak, medium, strong; "vault" is a Sinner's Sacrifice). The bot's frames carry each
            # camp's timer at the same position, so the map matches them by distance to get the kind.
            "camps": [
                {"kind": c.get("kind"), "x": c["position"][0], "y": c["position"][1]}
                for c in world.get("neutral_camps") or [] if isinstance(c, dict) and len(c.get("position") or []) >= 2
            ],
            # Where the Soul Urn can appear and where it is delivered, and the Unstable Rift's two spots.
            "urn_spawns": points(entities.get("soul_urn_spawns")),
            "urn_pads": points(entities.get("soul_urn_pads")),
            "rift_spots": points(entities.get("unstable_rifts")),
        },
    }


class Assets:
    """Refreshes ``live:assets`` every few hours; keeps the last good copy when deadlock-api is down."""

    def __init__(self, bus: redis.Redis, base_url: str, *, transport: httpx.BaseTransport | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.bus = bus
        self.clock = clock
        self.http = httpx.Client(base_url=base_url, timeout=30.0, transport=transport)
        self._next = 0.0

    def maybe_refresh(self) -> None:
        if self.clock() < self._next:
            return
        try:
            parts = [self.http.get(p).raise_for_status().json()
                     for p in ("/v1/assets/heroes", "/v1/assets/ranks", "/v1/assets/items", "/v1/assets/map")]
            data = compact_assets(parts[0], parts[1], parts[2], parts[3])
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            log.warning("assets unavailable, keeping the last copy: %s", e)
            self._next = self.clock() + 300
            return
        self.bus.set(ASSETS_KEY, json.dumps(data))
        self._next = self.clock() + ASSETS_EVERY_S
        log.info("assets refreshed: %d heroes, %d items", len(data["heroes"]), len(data["items"]))

    def close(self) -> None:
        self.http.close()
