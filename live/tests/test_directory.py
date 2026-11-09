"""Live directory: names and ranks cached and batched, badges averaged, assets compacted."""

from __future__ import annotations

import json
from typing import Any, cast

import httpx

from naebka_live.directory import Enricher, average_badge, badge_from_index, badge_index, build_directory, compact_assets


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.ttl: dict[str, int | None] = {}

    def get(self, key: str) -> Any:
        return self.values.get(key)

    def set(self, key: str, value: Any, ex: int | None = None) -> None:
        self.values[key] = value
        self.ttl[key] = ex

    def mget(self, keys: list[str]) -> list[Any]:
        return [self.values.get(k) for k in keys]

    def pipeline(self) -> FakeRedis:
        return self

    def execute(self) -> None:
        pass


def test_badges_average_on_a_linear_scale() -> None:
    assert badge_index(105) == 64  # tier 10, subrank 5
    assert badge_from_index(64) == 105
    assert badge_index(0) is None and badge_index(17) is None
    # Ascendant VI and Eternus I average to the boundary, not to a nonsense badge like 108.
    assert average_badge([106, 111]) in (106, 111)
    assert average_badge([None, 0]) is None


def raw(match_id: int, accounts: list[int]) -> dict[str, Any]:
    return {
        "match_id": match_id, "start_time": 1_000, "match_mode": 4, "game_mode": 1, "region_mode_parsed": "europe",
        "spectators": 3, "net_worth_team_0": 10_000, "net_worth_team_1": 9_000,
        "objectives_mask_team0": 65535, "objectives_mask_team1": 65093,
        "players": [{"account_id": a, "team": i % 2, "hero_id": 10 + i} for i, a in enumerate(accounts)],
    }


def test_directory_has_names_ranks_and_the_rank_spread() -> None:
    info = {1: {"name": "a", "avatar": None, "badge": 105}, 2: {"name": "b", "avatar": None, "badge": 95}}
    d = build_directory([raw(7, [1, 2]), raw(8, [3])], info, tracked={"7"}, source="deadlock-api", now=1_060)
    first = d["matches"][0]
    assert first["match_mode"] == "ranked" and first["region"] == "europe"
    assert first["tracked"] is True and d["matches"][1]["tracked"] is False
    assert first["players"][0]["name"] == "a" and first["players"][1]["badge"] == 95
    assert first["team_badges"] == [105, 95]
    assert first["objectives_alive"] == [16, 10]
    assert first["elapsed_s"] == 60
    assert d["rank_spread"] == [{"tier": 10, "matches": 1}]  # the match with no ranked player is left out


def test_names_and_ranks_are_fetched_once_and_cached() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        ids = [int(x) for x in request.url.params["account_ids"].split(",")]
        if request.url.path == "/v1/players/steam":
            return httpx.Response(200, content=json.dumps([{"account_id": a, "personaname": f"p{a}"} for a in ids if a != 3]))
        return httpx.Response(200, content=json.dumps([{"account_id": a, "badge": 80 + a} for a in ids]))

    bus = FakeRedis()
    now = [100.0]
    enricher = Enricher(cast(Any, bus), "http://api.test", clock=lambda: now[0], transport=httpx.MockTransport(handler))
    first = enricher.lookup([1, 2, 3])
    assert first[1] == {"name": "p1", "avatar": None, "badge": 81}
    assert first[3]["name"] is None  # no Steam profile: remembered as unknown
    assert bus.ttl["naebka:pname:3"] == 6 * 3600 and bus.ttl["naebka:pname:1"] == 24 * 3600
    assert calls == ["/v1/players/steam", "/v1/players/rank"]

    enricher.lookup([1, 2, 3])
    assert len(calls) == 2  # everything came from the cache

    enricher.lookup([4])
    assert calls[-1] == "/v1/players/steam"  # the rank call waits for its 5 s gap
    now[0] += 6
    assert enricher.lookup([4])[4]["badge"] == 84


def test_assets_keep_only_what_the_site_draws() -> None:
    heroes = [{"id": 1, "name": "Infernus", "images": {"icon_image_small": "i.png", "minimap_image_webp": "m.webp"}, "colors": {"ui": [1, 2, 3]}}]
    ranks = [{"tier": 10, "name": "Ascendant", "images": {"large": "l.png", "large_webp": "l.webp"}, "color": "#fff"}]
    items = [{"id": 5, "type": "upgrade", "name": "Extended Magazine", "image": "x.png", "item_tier": 1, "item_slot_type": "weapon"},
             {"id": 6, "type": "ability", "ability_type": "signature", "name": "Fireball", "image": "f.png", "image_webp": "f.webp"},
             {"id": 7, "type": "ability", "ability_type": "innate", "name": "Jump"}]
    world = {"radius": 10752, "images": {"minimap": "map.png"},
             "zipline_paths": [{"origin": [10, 20, 0], "color": "#29b1cc", "P0_points": [[0, 0, 0], [1, 2, 3]]}],
             "neutral_camps": [{"name": "dock_camp", "kind": "strong", "position": [-9248.0, 0.0, 288.9], "icon": "large.png"},
                               {"name": "drug_store_camp", "kind": "vault", "position": [2208.0, -960.0, 400.0], "icon": "vault.png"}],
             "entities": {"soul_urn_spawns": [{"position": [-6584.0, 0.0, 144.0]}], "soul_urn_pads": [{"position": [6304.0, -96.0, 192.0]}],
                          "unstable_rifts": [{"position": [-7648.0, 0.0, 420.0]}, {"position": [7648.0, 0.0, 420.0]}]}}
    a = compact_assets(heroes, ranks, items, world)
    assert a["heroes"]["1"] == {"name": "Infernus", "icon": "i.png", "minimap": "m.webp", "color": [1, 2, 3]}
    assert a["ranks"]["10"]["image"] == "l.webp"
    assert list(a["items"]) == ["5"]
    assert a["abilities"] == {"6": {"name": "Fireball", "image": "f.webp"}}  # hero abilities only, not Jump
    assert a["map"]["lanes"][0]["points"] == [[10, 20], [11, 22]]
    assert a["map"]["radius"] == 10752
    assert a["map"]["camps"] == [{"kind": "strong", "x": -9248.0, "y": 0.0}, {"kind": "vault", "x": 2208.0, "y": -960.0}]
    assert a["map"]["urn_spawns"] == [[-6584.0, 0.0]] and a["map"]["urn_pads"] == [[6304.0, -96.0]]
    assert a["map"]["rift_spots"] == [[-7648.0, 0.0], [7648.0, 0.0]]
    # Older map data without camps or entities still works.
    assert compact_assets([], [], [], {"radius": 1})["map"]["camps"] == []
