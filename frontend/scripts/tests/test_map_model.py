"""The 3D view's map builder (scripts/map_model.py) on small made-up maps: the nav mesh reader, what counts as an
interior and which interiors are one, the floors it fills in, and the geometry it keeps for them.

    python -m pytest scripts/tests        (from frontend/; numpy, Pillow and pytest)
"""
import struct

import numpy as np
import pytest

import map_model as mm

R = 4096.0  # the made-up maps' square: -R..R


def square(x0: float, y0: float, x1: float, y1: float, z: float) -> np.ndarray:
    """A floor's corners, anticlockwise seen from above (the game's y is north)."""
    return np.array([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], float)


def triangles(*floors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vertices and triangles (two a square) of floors, as simplify() returns them."""
    V = np.concatenate(floors).astype(np.float32)
    T = np.array([[4 * k + a for a in t] for k in range(len(floors)) for t in ((0, 1, 2), (0, 2, 3))])
    return V, T


# ---------------------------------------------------------------- the nav mesh file

def nav_file(polys: list[tuple[np.ndarray, int, list[list[int]]]]) -> bytes:
    """A .nav file as the game writes one (version 36): each polygon with its agent hull and, per edge, the ids of
    the areas across it. Area i + 1 is polygon i."""
    corners = np.concatenate([p for p, _, _ in polys]).astype('<f4')
    out = bytearray(struct.pack('<II', 0xFEEDFACE, 36) + bytes(16))
    out += b'\x01\x00\xdd\xee\xff' + struct.pack('<I', len(corners)) + corners.tobytes()
    out += struct.pack('<I', len(polys))
    first = 0
    for p, _, _ in polys:
        out += struct.pack('<B', len(p)) + struct.pack(f'<{len(p)}I', *range(first, first + len(p))) + b'\xff' * 4
        first += len(p)
    out += bytes(8) + b'\x05\x33generation params' + b'\x01\x00\xdd\xee\xff' + struct.pack('<I', len(polys))
    for i, (p, hull, edges) in enumerate(polys):
        out += struct.pack('<IqBII', i + 1, 0, hull, i, 0)
        for k in range(len(p)):
            across = edges[k] if k < len(edges) else []
            out += struct.pack('<I', len(across)) + b''.join(struct.pack('<II', a, 0) for a in across)
        out += b'\x00' + struct.pack('<III', 0, 0, 0)
    return bytes(out) + b'hull definitions follow'


def test_the_nav_mesh_gives_one_hulls_polygons_and_which_meet():
    a, b, c = square(0, 0, 100, 100, 0), square(100, 0, 200, 100, 0), square(0, 0, 100, 100, 0)
    # a and b meet across a's second edge; c is the same floor for the "trooper" hull.
    data = nav_file([(a, 0, [[], [2]]), (b, 0, [[], [], [], [1]]), (c, 1, [])])
    polys, links = mm.nav_polygons(data)
    assert len(polys) == 2
    np.testing.assert_allclose(polys[0], a)
    np.testing.assert_allclose(polys[1], b)
    assert sorted(links) == [(0, 1), (1, 0)]
    trooper, _ = mm.nav_polygons(data, hull=1)
    assert len(trooper) == 1


def test_the_nav_mesh_reader_gives_up_on_what_it_does_not_know():
    good = nav_file([(square(0, 0, 100, 100, 0), 0, [])])
    with pytest.warns(UserWarning):
        assert mm.nav_polygons(b'\x00' * 64) == ([], [])  # not a nav mesh
    with pytest.warns(UserWarning):
        assert mm.nav_polygons(good[:4] + struct.pack('<I', 30) + good[8:]) == ([], [])  # an older version
    with pytest.warns(UserWarning):
        assert mm.nav_polygons(good[:60]) == ([], [])  # cut short


# ---------------------------------------------------------------- what is an interior, and which are one

def test_cell_samples_give_each_cell_centre_inside_a_triangle_with_its_height():
    tri = np.array([[[0, 0, 0], [120, 0, 120], [0, 120, 0]]], float)  # rising to the east
    cells, which, z = mm.cell_samples(tri, R, 32.0)
    n = int(2 * R / 32)
    # The centres (16, 16), (48, 16), (80, 16), (16, 48), (48, 48) and (16, 80): those with x + y < 120.
    assert len(cells) == 6
    assert set(which) == {0}
    for c, h in zip(cells, z):
        x = (c % n + 0.5) * 32 - R
        assert h == pytest.approx(x)


def test_interiors_are_the_nav_polygons_on_floors_no_camera_sees():
    street, tunnel = square(0, 0, 256, 256, 0), square(512, 0, 768, 256, -400)
    V, T = triangles(street, tunnel)
    seen = np.array([True, True, False, False])  # the street's two triangles are seen; the tunnel's aren't
    nav = [square(32, 32, 224, 224, 0), square(544, 32, 736, 224, -400), square(544, 32, 736, 224, -200)]
    # On the street: no. In the tunnel: yes. Floating 200 above the tunnel's floor, over nothing: no.
    assert mm.interiors(nav, V, T, seen, R) == [1]
    assert mm.interiors([], V, T, seen, R) == []


def test_floors_meeting_at_a_step_or_a_drop_are_one_interior_but_not_storeys_or_rooms_apart():
    polys = [
        square(0, 0, 128, 128, 0),  # 0: a hall's floor
        square(128, 0, 256, 128, -60),  # 1: a sunken corner beside it, no walking link (the Mid-Boss hall has one)
        square(0, 0, 128, 128, 400),  # 2: the storey above the hall
        square(1024, 0, 1152, 128, 0),  # 3: another hall, far off
        square(1152, 0, 1280, 128, 0),  # 4: walked into from 3
    ]
    inner = [0, 1, 2, 3, 4]
    touching = mm.touching(polys, inner, R)
    assert (0, 1) in touching and (0, 2) not in touching and (1, 3) not in touching
    groups = mm.regions(inner, [(3, 4)] + touching)
    assert sorted(sorted(g) for g in groups) == [[0, 1], [2], [3, 4]]
    assert mm.touching(polys, [], R) == []


def test_floor_area_and_growing():
    assert mm.floor_area(square(0, 0, 100, 200, 5)) == pytest.approx(20_000)
    grown = mm.grown([square(0, 0, 100, 100, 7)], by=32)[0]
    # Each corner 32 further from the middle, at the same height.
    centre = np.array([50, 50])
    for before, after in zip(square(0, 0, 100, 100, 7), grown):
        assert np.linalg.norm(after[:2] - centre) == pytest.approx(np.linalg.norm(before[:2] - centre) + 32)
        assert after[2] == 7


def ring(outer: float, inner: tuple[float, float], z: float) -> list[np.ndarray]:
    """Four floors round a square hole (inner: from, to), in a square from 0 to `outer`."""
    a, b = inner
    return [square(0, 0, outer, a, z), square(0, b, outer, outer, z), square(0, a, a, b, z), square(b, a, outer, b, z)]


def covers(patches: list[np.ndarray], x: float, y: float) -> list[float]:
    """Heights of the patches over point (x, y)."""
    return [p[0, 2] for p in patches if p[:, 0].min() <= x <= p[:, 0].max() and p[:, 1].min() <= y <= p[:, 1].max()]


def test_holes_round_pillars_are_filled_at_the_floors_height_but_courtyards_are_not():
    pillar = mm.holes(ring(320, (128, 192), 50), R)
    assert covers(pillar, 150, 150) == [pytest.approx(50)]
    assert covers(pillar, 330, 150) == covers(pillar, -10, 150) == []  # nothing beyond the floor
    courtyard = mm.holes(ring(1600, (320, 1280), 50), R)
    assert covers(courtyard, 800, 800) == []  # 30 × 30 cells: open to the sky, so not an interior's floor


def test_gaps_between_floors_are_closed_but_nothing_is_added_round_them():
    patches = mm.holes([square(0, 0, 320, 320, 10), square(352, 0, 672, 320, 10)], R)  # a 32-unit gap between
    assert covers(patches, 336, 150) == [pytest.approx(10)]
    for x, y in [(336, 336), (336, -16), (-16, 150), (688, 150), (150, 336)]:
        assert covers(patches, x, y) == [], (x, y)  # one cell past the floors' edges


# ---------------------------------------------------------------- what the model keeps for interiors

def test_an_interiors_floor_and_walls_are_kept_but_not_what_covers_it():
    floor, roof = square(0, 0, 320, 320, 0), square(0, 0, 320, 320, 600)
    wall = np.array([[0, 330, 0], [320, 330, 0], [320, 330, 300], [0, 330, 300]], float)  # just past the floor's edge
    far_wall = np.array([[0, 900, 0], [320, 900, 0], [320, 900, 300], [0, 900, 300]], float)
    V, T = triangles(floor, roof, wall, far_wall)
    keep = mm.interior_geometry(V, T, [square(24, 24, 296, 296, 0)], R)
    assert keep.tolist() == [True, True, False, False, True, True, False, False]
    assert not mm.interior_geometry(V, T, [], R).any()


def tiles(x0: float, y0: float, x1: float, y1: float, z: float, step: float = 100) -> list[np.ndarray]:
    """A floor in step-sized squares, as small as the model's (the painter's algorithm sorts whole triangles)."""
    return [square(x, y, x + step, y + step, z) for x in np.arange(x0, x1, step) for y in np.arange(y0, y1, step)]


def test_a_floor_under_a_roof_is_hidden_from_every_camera_and_the_roof_and_streets_are_not():
    street = tiles(-3000, -3000, 3000, -1500, 0, 500)
    hall = tiles(-400, -400, 400, 400, 0)
    roof = tiles(-1200, -1200, 1200, 1200, 300)  # 800 over on each side: even the 62° camera can't see under
    V, T = triangles(*street, *hall, *roof)
    seen = mm.visible(V, T, R, size=1024)
    parts = np.cumsum([0, 2 * len(street), 2 * len(hall), 2 * len(roof)])
    street_seen, hall_seen, roof_seen = (seen[a:b] for a, b in zip(parts, parts[1:]))
    assert street_seen.all() and roof_seen.all()
    assert not hall_seen.any()


def box(x1: float, y1: float, z1: float, step: float) -> np.ndarray:
    """A box from (0, 0, 0) to (x1, y1, z1), bottomless, its faces in step-sized squares, facing out: (n, 3, 3)."""
    tris = []

    def face(origin, u, v, nu, nv):  # squares origin + i u + j v, facing u × v
        for i in range(nu):
            for j in range(nv):
                a = np.asarray(origin, float) + i * np.asarray(u, float) + j * np.asarray(v, float)
                b, c, d = a + u, a + np.asarray(u) + v, a + v
                tris.extend([[a, b, c], [a, c, d]])

    nx, ny, nz = int(x1 / step), int(y1 / step), int(z1 / step)
    face((0, 0, z1), (step, 0, 0), (0, step, 0), nx, ny)  # top
    face((x1, 0, 0), (0, step, 0), (0, 0, step), ny, nz)  # east
    face((0, 0, 0), (0, 0, step), (0, step, 0), nz, ny)  # west
    face((0, y1, 0), (0, 0, step), (step, 0, 0), nz, nx)  # north
    face((0, 0, 0), (step, 0, 0), (0, 0, step), nx, nz)  # south
    return np.array(tris)


def test_simplifying_leaves_fewer_triangles_and_keeps_a_buildings_corners_sharp():
    tri = box(512, 512, 256, 64)
    V, T = mm.simplify(tri, 200.0)
    assert 0 < len(T) < len(tri) / 4
    # Where the roof meets two walls, a vertex is at the corner (within a couple of units: the cell's vertex is the
    # point that best fits its planes, nudged a little towards the cell's middle).
    for corner in ([512, 512, 256], [0, 0, 256], [512, 0, 256]):
        assert np.linalg.norm(V - np.asarray(corner, float), axis=1).min() < 2.0, corner
