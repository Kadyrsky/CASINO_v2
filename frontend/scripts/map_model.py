"""Builds the realtime map's 3D view model from the game's own map: Deadlock's collision geometry (the solid world,
already simple, with its roofs), simplified further and coloured with the game's materials.

    python scripts/map_model.py              (from frontend/; Python 3.14+, numpy and Pillow: pip install numpy pillow)
    python scripts/map_model.py --game "D:/SteamLibrary/steamapps/common/Deadlock"
    python scripts/map_model.py --quality high      (the more detailed model the 3D view's High quality loads)

Reads the map from a local Deadlock install (found through Steam, or --game) and writes public/maps/<map>.bin.gz.
Run it again after a patch that changes the map. Nothing is downloaded but the site's own minimap (from deadlock-api,
the image the 2D map shows), which marks the playable area. The geometry and colours are Valve's, like the music.

How it works:
1. maps/<map>.vpk: world_physics.vmdl_c holds the collision world as binary KeyValues3 (zstd or LZ4). Its solid
   shapes (not clips, sky or line-of-sight blockers) are kept inside the minimap's playable area.
2. Faces pointing down (never seen from above) go, and the rest is simplified by vertex clustering on a 3D grid,
   each cell's vertex placed where it best fits the planes of its triangles (Lindstrom's out-of-core method), which
   keeps building corners sharp. Triangles that no 2.5D camera can see (ID buffers from 17 views) go too.
3. Colours: every render draw call of the map (world node and model meshes) has a world-space box, a material and a
   tint. A material's colour is its colour texture's precomputed average (the "reflectivity" in the texture header)
   times the material's colour tint. Each triangle takes the colour of the smallest draw call box that holds it;
   near-black ones (glass, which the game shows by its reflections) are left out.
4. A ground height grid places markers that have no height of their own on the streets (frames from bots older than
   heights; newer frames have z for everything).
5. The Mid-Boss's arena is a hall under the middle of the map (floor at about -830, ceiling at about -150, the plaza
   and its buildings on top), so no camera sees into it. Its triangles are kept anyway, and the file gives its box (the
   3D view stands the Mid-Boss on the plaza while nobody is down there).
6. Interiors: heroes spend about a fifth of their time where no camera sees them (the arena, the tunnels around it, the
   bases' covered courts, big halls). The map's nav mesh (maps/<map>.nav) has the polygons its bots walk on; those
   lying on the model's hidden floors, in connected groups (linked by the nav mesh, or meeting within a step or drop)
   of at least MIN_ROOM, are the interiors (the rest are nooks under arches). Their floors and walls are kept too, and
   the file gives each interior's floor (its nav polygons and strips filling the holes round pillars), so the 3D view
   can cut away what stands between the camera and a hero in one.

The file (little-endian, gzipped): magic "NMAP", version 3 (u32), radius (f32: the square is -radius..radius, as the
minimap's), zMin, zMax (f32), vertex count, triangle count, height grid size (u32); then the vertices as u16 x, y, z
quantized over the square and zMin..zMax (y to the north, as in the game); the triangles as u32 vertex indices; their
sRGB colours (3 × u8); the height grid (u16 over zMin..zMax, rows from the north); the arena's box (f32 world units:
x and y from, x and y to, and the height above which it is covered; all 0 when the map has none); and the interiors'
floors: corner count, triangle count (u32), the corners quantized as the vertices are, the triangles (3 × u32) and
each triangle's interior (u16). Version 2 files end after the box, version 1 files before it.
"""
import argparse
import gzip
import json
import re
import struct
import sys
import time
import urllib.request
import warnings
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

try:
    from compression import zstd  # Python 3.14+

    def unzstd(data: bytes) -> bytes:
        return zstd.decompress(data)
except ImportError:  # older Python: pip install zstandard
    import zstandard

    def unzstd(data: bytes) -> bytes:
        return zstandard.ZstdDecompressor().decompressobj().decompress(data)


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'maps'
ASSETS = 'https://api.deadlock-api.com/v1/assets/map'
UA = {'User-Agent': 'naebka-map-model/1.0 (student project; occasional map import)'}

# Simplification grid (world units) of each model: the 3D view's usual one, and the more detailed one its High
# quality setting loads (about twice the triangles: the collision geometry has little finer detail to keep).
CELLS = {'standard': 64.0, 'high': 16.0}
MIN_HULL = 150.0  # convex hulls smaller than this (props) are left out
# World heights kept; towers above are cut. The lowest floor is the Mid-Boss's arena, at about -830.
Z_MIN, Z_MAX = -1000.0, 5200.0
# The Mid-Boss's arena: its floor is what faces up below ARENA_FLOOR within ARENA_REACH of the middle; it is covered
# above ARENA_TOP (its walls and ramps are lower, its ceiling higher).
ARENA_FLOOR, ARENA_REACH, ARENA_TOP = -700.0, 1500.0, -250.0
EDGE_TALL = 2000.0  # just outside the playable area, only what is lower than this (no backdrop skyline)
# Interiors: the nav mesh's "default" agent (24 units round, 80 tall, as scripts/nav_hulls.vdata has it) walks where
# heroes do. Its polygons are compared with the model's floors on a 32-unit grid; around an interior's floor the
# hidden geometry from 48 below to 400 above is kept (its floor and walls); its polygons grow by 32 units, since nav
# polygons stop an agent's radius short of the walls.
NAV_HULL = 0
INTERIOR_CELL = 32.0
INTERIOR_BAND = (-48.0, 400.0)
INTERIOR_GROW = 32.0
HOLE_CELLS = 120  # holes in an interior's floor up to this many cells (pillars, props) are filled; courtyards aren't
CLOSE_CELLS = 3  # and gaps between its polygons up to about twice this many cells across
# Interiors smaller than this (square units of floor) are nooks under arches and awnings, left covered: about 1,000
# of the 1,200, where heroes spend under a tenth of their time in interiors (measured on live broadcasts).
MIN_ROOM = 50_000.0
# Floors that meet within this height are one interior although the nav mesh doesn't link them (a step, a drop).
MERGE_STEP = 160.0
HEIGHT_GRID = 512
FALLBACK = (0.36, 0.35, 0.33)  # linear colour of triangles no draw call box holds
DARKEST = 0.015  # draw calls darker than this (linear luminance: glass) don't colour the geometry


# ---------------------------------------------------------------- files: VPK packs and compiled resources

class Vpk:
    """A Valve pack: a single file (maps), or a _dir.vpk with numbered archives (pak01)."""

    def __init__(self, path: Path):
        self.path = str(path)
        self.base = self.path[:-len('_dir.vpk')] if self.path.endswith('_dir.vpk') else None
        with open(self.path, 'rb') as f:
            sig, ver, tree = struct.unpack('<III', f.read(12))
            if sig != 0x55AA1234:
                raise ValueError(f'{path} is not a VPK')
            header = 28 if ver == 2 else 12
            f.seek(header)
            data = f.read(tree)
        self.data_start = header + tree
        self.entries: dict[str, tuple[int, int, int, bytes]] = {}
        p = 0

        def text() -> str:
            nonlocal p
            e = data.index(b'\0', p)
            s = data[p:e].decode('utf-8', 'replace')
            p = e + 1
            return s

        while ext := text():
            while folder := text():
                while name := text():
                    _crc, preload, archive, offset, length, _end = struct.unpack_from('<IHHIIH', data, p)
                    p += 18
                    pre = data[p:p + preload]
                    p += preload
                    folder = folder.strip()
                    self.entries[f'{folder}/{name}.{ext}' if folder else f'{name}.{ext}'] = (archive, offset, length, pre)

    def read(self, name: str) -> bytes:
        archive, offset, length, pre = self.entries[name]
        inside = archive == 0x7FFF
        with open(self.path if inside else f'{self.base}_{archive:03d}.vpk', 'rb') as f:
            f.seek(self.data_start + offset if inside else offset)
            return pre + f.read(length)


def blocks(data: bytes) -> dict[str, bytes]:
    """The blocks of a compiled Source 2 resource, by type (the first of each)."""
    _size, _hv, _v, offset, count = struct.unpack_from('<IHHII', data, 0)
    out = {}
    p = 8 + offset
    for _ in range(count):
        kind = data[p:p + 4].decode('ascii', 'replace')
        rel, size = struct.unpack_from('<II', data, p + 4)
        out.setdefault(kind, data[p + 4 + rel:p + 4 + rel + size])
        p += 12
    return out


# ---------------------------------------------------------------- binary KeyValues3 (versions 1-5)

def lz4_into(src: bytes, out: bytearray) -> bytearray:
    """Decodes a raw LZ4 block onto the end of `out`; matches may reach back into what `out` already holds."""
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += src[i:i + lit]
        i += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(out) - off
        if off >= ml:
            out += out[start:start + ml]
        else:
            for k in range(ml):
                out.append(out[start + k])
    return out


NULL, BOOLEAN, INT64, UINT64, DOUBLE, STRING, BLOB, ARRAY, OBJECT, ARRAY_TYPED, INT32, UINT32 = range(1, 13)
TRUE, FALSE, INT64_ZERO, INT64_ONE, DOUBLE_ZERO, DOUBLE_ONE, FLOAT, INT16, UINT16, INT8, UINT8 = range(13, 24)
ARRAY_BYTE_LENGTH, ARRAY_AUX, UINT32_ZERO, UINT32_ONE = 24, 25, 26, 27
PACKED = {BOOLEAN: (1, '?'), INT8: (1, 'i1'), UINT8: (1, 'u1'), INT16: (2, '<i2'), UINT16: (2, '<u2'),
          INT32: (4, '<i4'), UINT32: (4, '<u4'), FLOAT: (4, '<f4'), INT64: (8, '<i8'), UINT64: (8, '<u8'),
          DOUBLE: (8, '<f8')}


class _Lane:
    """The 1-, 2-, 4- and 8-byte value lanes of a buffer, each read front to back."""

    def __init__(self, buf: bytes, starts, ends):
        self.buf, self.pos, self.end = buf, dict(zip((1, 2, 4, 8), starts)), dict(zip((1, 2, 4, 8), ends))

    def take(self, width: int, count: int) -> bytes:
        p = self.pos[width]
        q = p + width * count
        if q > self.end[width]:
            raise ValueError('KV3 lane overrun')
        self.pos[width] = q
        return self.buf[p:q]

    def read(self, fmt: str):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt), 1))[0]


def _lanes(start: int, c1: int, c2: int, c4: int, c8: int, align_empty: bool):
    def align(o, a):
        return (o + a - 1) // a * a

    o = s1 = start
    o += c1
    s2 = o = align(o, 2) if (c2 or align_empty) else o
    o += 2 * c2
    s4 = o = align(o, 4) if (c4 or align_empty) else o
    o += 4 * c4
    s8 = o = align(o, 8) if (c8 or align_empty) else o
    o += 8 * c8
    return (s1, s2, s4, s8), (s1 + c1, s2 + 2 * c2, s4 + 4 * c4, s8 + 8 * c8), o


def _unpack(method: int, data: bytes, size: int) -> bytes:
    if method == 0:
        return data[:size]
    if method == 1:
        return bytes(lz4_into(data, bytearray()))
    if method == 2:
        return unzstd(data)
    raise ValueError(f'KV3 compression {method} is not supported')


def kv3(data: bytes):
    """Parses binary KV3: objects become dicts, typed number arrays numpy arrays, blobs bytes."""
    magic, = struct.unpack_from('<I', data, 0)
    if magic & 0xFFFFFF00 != 0x4B563300:
        raise ValueError('not binary KV3')
    version = magic & 0xFF
    p = 20
    method, = struct.unpack_from('<I', data, p)
    p += 4
    c2 = c_types = n_blocks = blob_bytes = 0
    if version == 1:
        c1, c4, c8, size_total = struct.unpack_from('<iiii', data, p)
        p += 16
        comp_total = len(data) - p
    else:
        (_dict, _frame, c1, c4, c8, c_types, _nobj, _narr, size_total, comp_total, n_blocks,
         blob_bytes) = struct.unpack_from('<HHiiiiHHiiii', data, p)
        p += 40
    if version >= 4:
        c2, _ = struct.unpack_from('<ii', data, p)
        p += 8
    ctx = {'version': version, 'objpos': 0}
    if version >= 5:
        u1, k1, u2, k2, b1, b2, b4, b8, _nodes, nobj2, _narr2, _nelem = struct.unpack_from('<12i', data, p)
        p += 48
        raw1 = _unpack(method, data[p:p + k1], u1)
        p += k1
        raw2 = _unpack(method, data[p:p + k2], u2)
        p += k2
        starts, ends, _ = _lanes(0, c1, c2, c4, c8, False)
        aux = _Lane(raw1, starts, ends)
        strings = []
        for _ in range(aux.read('<i')):
            e = raw1.index(b'\0', aux.pos[1])
            strings.append(raw1[aux.pos[1]:e].decode('utf-8', 'replace'))
            aux.pos[1] = e + 1
        starts, ends, o = _lanes(4 * nobj2, b1, b2, b4, b8, False)
        main = _Lane(raw2, starts, ends)
        types = raw2[o:o + c_types]
        o += c_types
        ctx['objlens'] = np.frombuffer(raw2, '<i4', nobj2, 0)
        rest, sizes_at = raw2, o
    else:
        raw = _unpack(method, data[p:p + comp_total], size_total)
        p += comp_total
        starts, ends, o = _lanes(0, c1, c2, c4, c8, True)
        main = aux = _Lane(raw, starts, ends)
        strings = []
        for _ in range(main.read('<i')):
            e = raw.index(b'\0', o)
            strings.append(raw[o:e].decode('utf-8', 'replace'))
            o = e + 1
        types_len = (size_total - o - 4) if version == 1 else c_types - (o - ends[3])
        types = raw[o:o + types_len]
        o += types_len
        rest, sizes_at = raw, o
    blobs = []
    if n_blocks:
        sizes = struct.unpack_from(f'<{n_blocks}i', rest, sizes_at)
        if method == 2 and version >= 5:
            allb = unzstd(data[p:p + comp_total - k1 - k2])
        elif method == 2:
            allb = rest[size_total:size_total + blob_bytes]
        elif method == 0:
            allb = data[p:p + blob_bytes]
        else:  # LZ4: each blob in chained frames; their compressed sizes (u16) follow the blob sizes and a trailer
            fs = sizes_at + 4 * n_blocks + 4
            allb = bytearray()
            for s in sizes:
                goal = len(allb) + s
                while len(allb) < goal:
                    clen, = struct.unpack_from('<H', rest, fs)
                    fs += 2
                    lz4_into(data[p:p + clen], allb)
                    p += clen
        q = 0
        for s in sizes:
            blobs.append(bytes(allb[q:q + s]))
            q += s
    ctx.update(strings=strings, types=types, tpos=0, main=main, aux=aux, blobs=blobs, blob=0)
    return _kv3_value(ctx, _kv3_type(ctx), main)


def _kv3_type(ctx) -> int:
    types = ctx['types']
    b = types[ctx['tpos']]
    ctx['tpos'] += 1
    if b & 0x80:
        ctx['tpos'] += 1  # flag
    if ctx['version'] >= 3:
        if b & 0x40:
            ctx['tpos'] += 1
        return b & 0x3F
    return b & 0x7F


def _kv3_value(ctx, t: int, lane: _Lane):
    main = ctx['main']
    if t == NULL:
        return None
    if t in (TRUE, FALSE):
        return t == TRUE
    if t in (INT64_ZERO, UINT32_ZERO, INT64_ONE, UINT32_ONE):
        return int(t in (INT64_ONE, UINT32_ONE))
    if t in (DOUBLE_ZERO, DOUBLE_ONE):
        return float(t == DOUBLE_ONE)
    if t in PACKED:
        width, dt = PACKED[t]
        return np.frombuffer(lane.take(width, 1), dt)[0].item()
    if t == STRING:
        i = main.read('<i')
        return ctx['strings'][i] if 0 <= i < len(ctx['strings']) else ''
    if t == BLOB:
        if ctx['version'] < 2:
            return bytes(main.take(1, main.read('<i')))
        ctx['blob'] += 1
        return ctx['blobs'][ctx['blob'] - 1]
    if t == ARRAY:
        return [_kv3_value(ctx, _kv3_type(ctx), main) for _ in range(main.read('<i'))]
    if t in (ARRAY_TYPED, ARRAY_BYTE_LENGTH, ARRAY_AUX):
        n = main.read('<i') if t == ARRAY_TYPED else main.read('<B')
        sub = _kv3_type(ctx)
        el = ctx['aux'] if t == ARRAY_AUX else main
        if sub in PACKED:
            width, dt = PACKED[sub]
            return np.frombuffer(el.take(width, n), dt).copy()
        return [_kv3_value(ctx, sub, el) for _ in range(n)]
    if t == OBJECT:
        if ctx['version'] >= 5:
            n = int(ctx['objlens'][ctx['objpos']])
            ctx['objpos'] += 1
        else:
            n = main.read('<i')
        out = {}
        for _ in range(n):
            sub = _kv3_type(ctx)
            i = main.read('<i')
            out[ctx['strings'][i] if 0 <= i < len(ctx['strings']) else ''] = _kv3_value(ctx, sub, main)
        return out
    raise ValueError(f'unknown KV3 type {t}')


# ---------------------------------------------------------------- the collision world

SKIP_TAGS = {'playerclip', 'npcclip', 'sky', 'citadel_skyclip', 'blocklos', 'window', 'navignore'}


def visible_attribute(attr: dict) -> bool:
    """Solid world or foliage; not clips, sky, windows or line-of-sight blockers."""
    tags = {t.lower() for t in attr.get('m_InteractAsStrings', [])}
    if tags & {'solid', 'citadel_foliage', 'passbullets'}:
        return True
    if tags & SKIP_TAGS:
        return False
    return attr.get('m_CollisionGroupString', '').lower() == 'default'


def hull_triangles(h: dict) -> np.ndarray:
    """Fan-triangulates a convex hull from its half-edges (next, twin, origin, face), wound outwards."""
    P = np.frombuffer(h['m_VertexPositions'], '<f4').reshape(-1, 3)
    E = np.frombuffer(h['m_Edges'], 'u1').reshape(-1, 4)
    centre = P.mean(0)
    out = []
    for f in np.frombuffer(h['m_Faces'], 'u1'):
        loop, e = [], int(f)
        for _ in range(64):
            loop.append(P[E[e, 2]])
            e = int(E[e, 0])
            if e == f:
                break
        for i in range(1, len(loop) - 1):
            t = np.array([loop[0], loop[i], loop[i + 1]])
            if np.dot(np.cross(t[1] - t[0], t[2] - t[0]), t.mean(0) - centre) < 0:
                t = t[[0, 2, 1]]
            out.append(t)
    return np.array(out, np.float32).reshape(-1, 3, 3)


def world_triangles(phys: dict, radius: float) -> np.ndarray:
    """Every visible solid triangle of the physics world near the map square, as (n, 3, 3) world positions."""
    attrs = phys['m_collisionAttributes']
    shape = phys['m_parts'][0]['m_rnShape']
    limit = radius + 1500
    tris = []

    def add(t):
        c = t.mean(1)
        tris.append(t[(np.abs(c[:, 0]) < limit) & (np.abs(c[:, 1]) < limit)])

    def mesh(m):
        V = np.frombuffer(m['m_Vertices'], '<f4').reshape(-1, 3)
        return V[np.frombuffer(m['m_Triangles'], '<i4').reshape(-1, 3)]

    for s in shape['m_meshes']:
        if visible_attribute(attrs[s['m_nCollisionAttributeIndex']]):
            add(mesh(s['m_Mesh']))
    for c in shape['m_compounds']:
        if not visible_attribute(attrs[c['m_nCollisionAttributeIndex']]):
            continue
        comp = c['m_Compound']
        for m in comp['m_Meshes']:
            add(mesh(m))
        for h in comp['m_Hulls']:
            lo, hi = np.asarray(h['m_Bounds']['m_vMinBounds']), np.asarray(h['m_Bounds']['m_vMaxBounds'])
            centre = (lo + hi) / 2
            if (hi - lo).max() >= MIN_HULL and abs(centre[0]) < limit and abs(centre[1]) < limit:
                add(hull_triangles(h))
    return np.concatenate(tris)


def playable_area(radius: float, size: int = 1024):
    """Masks (rows from the north) of the playable area, closed and widened by ~250 units for its outer walls, and
    of the streets (where the minimap is walkable)."""
    with urllib.request.urlopen(urllib.request.Request(ASSETS, headers=UA), timeout=60) as r:
        url = json.load(r)['images']['minimap']
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        img = Image.open(r).convert('RGBA').resize((size, size))
    street = np.asarray(img)[:, :, 3] >= 90
    outside = np.zeros((size, size), bool)
    queue = deque()
    for i in range(size):
        for y, x in ((0, i), (size - 1, i), (i, 0), (i, size - 1)):
            if not street[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < size and 0 <= nx < size and not street[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                queue.append((ny, nx))
    wide = Image.fromarray((~outside * 255).astype('u1')).filter(ImageFilter.MaxFilter(25))
    closed = wide.filter(ImageFilter.MinFilter(25))
    return np.asarray(closed) > 0, np.asarray(wide) > 0, street


def crop(tri: np.ndarray, radius: float, closed: np.ndarray, wide: np.ndarray) -> np.ndarray:
    size = closed.shape[0]
    c = tri.mean(1)
    px = np.clip(((c[:, 0] + radius) / (2 * radius) * size).astype(int), 0, size - 1)
    py = np.clip(((radius - c[:, 1]) / (2 * radius) * size).astype(int), 0, size - 1)
    keep = closed[py, px] | (wide[py, px] & (c[:, 2] < EDGE_TALL))
    keep &= (np.abs(tri[:, :, :2]).max((1, 2)) < radius + 1500) & (c[:, 2] > Z_MIN) & (c[:, 2] < Z_MAX)
    tri = tri[keep].copy()
    tri[:, :, 2] = np.clip(tri[:, :, 2], Z_MIN, Z_MAX)
    return tri


# ---------------------------------------------------------------- simplification

def normals(t: np.ndarray):
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    a = np.linalg.norm(n, axis=1)
    return n / np.maximum(a, 1e-12)[:, None], a / 2


def simplify(tri: np.ndarray, cell: float):
    """Vertex clustering with each cell's vertex at the point that best fits its triangles' planes (area weighted)."""
    n, area = normals(tri.astype(np.float64))
    ok = (area > 1e-3) & (n[:, 2] > -0.2)  # faces pointing down are never seen from above
    tri, n, area = tri[ok].astype(np.float64), n[ok], area[ok]
    P = tri.reshape(-1, 3)
    key = np.floor(P / cell).astype(np.int64) + (1 << 20)
    k = (key[:, 0] << 42) | (key[:, 1] << 21) | key[:, 2]
    uniq, inv = np.unique(k, return_inverse=True)
    cells = len(uniq)
    q = np.concatenate([n, -np.einsum('ij,ij->i', n, tri[:, 0])[:, None]], 1)
    Q = np.repeat((area[:, None, None] * q[:, :, None] * q[:, None, :]).reshape(-1, 16), 3, axis=0)
    acc = np.zeros((cells, 16))
    np.add.at(acc, inv, Q)
    mean = np.zeros((cells, 3))
    np.add.at(mean, inv, P)
    mean /= np.bincount(inv, minlength=cells)[:, None]
    A = acc[:, [0, 1, 2, 4, 5, 6, 8, 9, 10]].reshape(-1, 3, 3)
    lam = 1e-3 * np.trace(A, axis1=1, axis2=2)[:, None, None] + 1e-9
    best = np.linalg.solve(A + lam * np.eye(3), (-acc[:, [3, 7, 11]] + lam[:, :, 0] * mean)[:, :, None])[:, :, 0]
    lo = (((uniq[:, None] >> np.array([42, 21, 0])) & ((1 << 21) - 1)) - (1 << 20)) * cell
    near = np.all((best > lo - 0.25 * cell) & (best < lo + 1.25 * cell), axis=1)
    V = np.where(near[:, None], best, mean).astype(np.float32)
    T = inv.reshape(-1, 3)
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
    _, first = np.unique(np.sort(T, axis=1), axis=0, return_index=True)
    T = T[np.sort(first)]
    nn, aa = normals(V[T].astype(np.float64))
    return V, T[(aa > 1e-2) & (nn[:, 2] > -0.2)]


VIEWS = [(0, 0)] + [(tilt, yaw) for tilt in (35, 62) for yaw in range(0, 360, 45)]


def visible(V: np.ndarray, T: np.ndarray, radius: float, size: int = 2048) -> np.ndarray:
    """Per triangle: on top somewhere in at least one view (painter's algorithm, triangle ids as colours)."""
    seen = np.zeros(len(T), bool)
    P = V.astype(np.float64)
    extent = radius * 1.07
    for tilt, yaw in VIEWS:
        t, y = np.radians(tilt), np.radians(yaw)
        x = P[:, 0] * np.cos(y) - P[:, 1] * np.sin(y)
        yy = P[:, 0] * np.sin(y) + P[:, 1] * np.cos(y)
        sx = (x + extent) / (2 * extent) * size
        sy = (extent - (yy * np.cos(t) + P[:, 2] * np.sin(t))) / (2 * extent) * size + size * 0.1
        depth = yy * np.sin(t) - P[:, 2] * np.cos(t)
        img = Image.new('RGB', (size, int(size * 1.2)))
        draw = ImageDraw.Draw(img)
        X, Y = sx[T], sy[T]
        for i in np.argsort(-depth[T].mean(1)):
            k = int(i) + 1
            draw.polygon([(X[i, 0], Y[i, 0]), (X[i, 1], Y[i, 1]), (X[i, 2], Y[i, 2])],
                         fill=(k & 255, (k >> 8) & 255, k >> 16))
        a = np.asarray(img).astype(np.int64)
        ids = (a[:, :, 0] | (a[:, :, 1] << 8) | (a[:, :, 2] << 16)).ravel()
        seen[np.unique(ids[ids > 0]) - 1] = True
    return seen


def arena_box(tri: np.ndarray) -> tuple[float, float, float, float, float] | None:
    """The Mid-Boss arena's box (x0, y0, x1, y1, covered above): around the floor that faces up deep under the middle
    of the map, 50 units wider for its walls. None when the map has no such floor."""
    c = tri.mean(1)
    n, _ = normals(tri.astype(np.float64))
    floor = (n[:, 2] > 0.7) & (c[:, 2] < ARENA_FLOOR) & (np.abs(c[:, :2]) < ARENA_REACH).all(1)
    if not floor.any():
        return None
    lo = tri[floor][:, :, :2].min((0, 1)) - 50
    hi = tri[floor][:, :, :2].max((0, 1)) + 50
    return float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]), ARENA_TOP


def in_arena(V: np.ndarray, T: np.ndarray, box: tuple[float, float, float, float, float] | None) -> np.ndarray:
    """Per triangle: inside the arena, under what covers it."""
    if box is None:
        return np.zeros(len(T), bool)
    x0, y0, x1, y1, top = box
    c = V[T].astype(np.float64).mean(1)
    return (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 1] > y0) & (c[:, 1] < y1) & (c[:, 2] < top)


# ---------------------------------------------------------------- interiors: where heroes walk that no camera sees

def nav_polygons(data: bytes, hull: int = NAV_HULL) -> tuple[list[np.ndarray], list[tuple[int, int]]]:
    """The walkable polygons of a Source 2 nav mesh (maps/<map>.nav, version 35 or 36) for one agent hull, each an
    (n, 3) array of world positions, and which of them meet across an edge (index pairs); empty (with a warning) when
    the file isn't laid out as expected.

    Layout, as far as needed here: a header; a block marked by the bytes DD EE FF holding the corner positions (u32
    count, then x, y, z floats) and the polygons (u32 count; each a u8 corner count, that many u32 corner indices and a
    u32); a second header; then, after the next DD EE FF, the areas, one per polygon (u32 count; each a u32 id, u64
    flags, u8 hull, u32 polygon, u32, per edge a u32 count of (area id, edge) u32 pairs, a u8 and three u32-counted
    lists of u32)."""
    try:
        magic, version = struct.unpack_from('<II', data, 0)
        if magic != 0xFEEDFACE or not 35 <= version <= 36:
            raise ValueError(f'nav version {version}')
        p = data.index(b'\xdd\xee\xff', 16) + 3
        n_corners, = struct.unpack_from('<I', data, p)
        corners = np.frombuffer(data, '<f4', n_corners * 3, p + 4).reshape(-1, 3).astype(np.float64)
        p += 4 + n_corners * 12
        n_polys, = struct.unpack_from('<I', data, p)
        p += 4
        polys = []
        for _ in range(n_polys):
            k = data[p]
            polys.append(np.frombuffer(data, '<u4', k, p + 1))
            p += 1 + 4 * k + 4
        p = data.index(b'\xdd\xee\xff', p) + 3
        n_areas, = struct.unpack_from('<I', data, p)
        if n_areas != n_polys:
            raise ValueError(f'{n_areas} areas for {n_polys} polygons')
        p += 4
        out, ids, near = [], [], []
        for _ in range(n_areas):
            area, = struct.unpack_from('<I', data, p)
            agent, index = struct.unpack_from('<BI', data, p + 12)
            p += 21
            links = []
            for _ in range(len(polys[index])):
                count, = struct.unpack_from('<I', data, p)
                links += [struct.unpack_from('<I', data, p + 4 + 8 * k)[0] for k in range(count)]
                p += 4 + 8 * count
            p += 1
            for _ in range(3):
                p += 4 + 4 * struct.unpack_from('<I', data, p)[0]
            if agent == hull:
                out.append(corners[polys[index]])
                ids.append(area)
                near.append(links)
        at = {a: i for i, a in enumerate(ids)}
        return out, [(i, at[a]) for i, links in enumerate(near) for a in links if a in at]
    except (ValueError, IndexError, KeyError, struct.error) as e:
        warnings.warn(f'nav mesh not read ({e}): no interiors')
        return [], []


def cell_samples(tri: np.ndarray, radius: float, cell: float):
    """Every cell centre (of a cell × cell grid over the map square) inside each triangle seen from above, with the
    triangle's height there: (cell indices as row × columns + column, triangle indices, heights)."""
    n = int(np.ceil(2 * radius / cell))
    lo = np.floor((tri[:, :, :2].min(1) + radius) / cell - 0.5).astype(int)
    hi = np.floor((tri[:, :, :2].max(1) + radius) / cell - 0.5).astype(int) + 1
    w = np.clip(hi[:, 0] - lo[:, 0] + 1, 1, None)
    h = np.clip(hi[:, 1] - lo[:, 1] + 1, 1, None)
    count = w * h
    rep = np.repeat(np.arange(len(tri)), count)
    k = np.arange(count.sum()) - np.repeat(np.cumsum(count) - count, count)
    cx, cy = lo[rep, 0] + k % w[rep], lo[rep, 1] + k // w[rep]
    x, y = (cx + 0.5) * cell - radius, (cy + 0.5) * cell - radius
    a, b, c = tri[rep, 0], tri[rep, 1], tri[rep, 2]
    den = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    ok = np.abs(den) > 1e-9
    den = np.where(ok, den, 1)
    wa = ((b[:, 1] - c[:, 1]) * (x - c[:, 0]) + (c[:, 0] - b[:, 0]) * (y - c[:, 1])) / den
    wb = ((c[:, 1] - a[:, 1]) * (x - c[:, 0]) + (a[:, 0] - c[:, 0]) * (y - c[:, 1])) / den
    wc = 1 - wa - wb
    inside = ok & (wa >= -1e-6) & (wb >= -1e-6) & (wc >= -1e-6) & (cx >= 0) & (cy >= 0) & (cx < n) & (cy < n)
    z = wa * a[:, 2] + wb * b[:, 2] + wc * c[:, 2]
    return (cy * n + cx)[inside], rep[inside], z[inside]


def fans(polys: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """The polygons as triangles (n, 3, 3), and each triangle's polygon."""
    tri = [p[[0, k, k + 1]] for p in polys for k in range(1, len(p) - 1)]
    owner = [i for i, p in enumerate(polys) for _ in range(1, len(p) - 1)]
    return np.array(tri, np.float64).reshape(-1, 3, 3), np.array(owner, int)


def interiors(polys: list[np.ndarray], V: np.ndarray, T: np.ndarray, seen: np.ndarray, radius: float) -> list[int]:
    """Which nav polygons lie on floors no camera sees (in the tunnels, halls and covered courts): on a 32-unit grid,
    more than half of a polygon's samples lie within 48 units of the height of a hidden floor of the model."""
    if not polys:
        return []
    tri = V[T].astype(np.float64)
    n, _ = normals(tri)
    floors = np.nonzero(n[:, 2] > 0.5)[0]
    fc, ft, fz = cell_samples(tri[floors], radius, INTERIOR_CELL)
    hidden = ~seen[floors[ft]]
    order = np.lexsort((fz, fc))
    fc, fz, hidden = fc[order], fz[order], hidden[order]
    nav, owner = fans(polys)
    nc, nt, nz = cell_samples(nav, radius, INTERIOR_CELL)
    start, end = np.searchsorted(fc, nc, 'left'), np.searchsorted(fc, nc, 'right')
    near = np.full(len(nc), np.inf)
    under = np.zeros(len(nc), bool)
    for k in range(int((end - start).max(initial=0))):  # each nav sample takes the model floor nearest in height
        j = np.minimum(start + k, len(fc) - 1)
        dz = np.where(start + k < end, np.abs(fz[j] - nz), np.inf)
        better = (dz < 48) & (dz < near)
        near[better] = dz[better]
        under[better] = hidden[j][better]
    poly = owner[nt]
    total = np.bincount(poly[np.isfinite(near)], minlength=len(polys))
    covered = np.bincount(poly[under], minlength=len(polys))
    return [i for i, (t, c) in enumerate(zip(total, covered)) if t and c * 2 > t]


def floor_area(p: np.ndarray) -> float:
    """A polygon's area seen from above (shoelace)."""
    x, y = p[:, 0], p[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def touching(polys: list[np.ndarray], indices: list[int], radius: float) -> list[tuple[int, int]]:
    """Pairs of the given polygons whose floors meet on the 32-unit grid (in one cell or neighbouring ones) within
    MERGE_STEP of height: a step up, or a drop into a pit, that the nav mesh has no walking link across (the Mid-Boss
    hall's sunken corner is one)."""
    if not indices:
        return []
    tri, owner = fans([polys[i] for i in indices])
    cell, t, z = cell_samples(tri, radius, INTERIOR_CELL)
    n = int(np.ceil(2 * radius / INTERIOR_CELL))
    at: dict[int, list[tuple[float, int]]] = {}
    for c, k, h in zip(cell.tolist(), owner[t].tolist(), z.tolist()):
        at.setdefault(c, []).append((h, indices[k]))
    pairs = set()
    for c, here in at.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for h, a in here:
                    for g, b in at.get(c + dy * n + dx, ()):
                        if a < b and abs(h - g) <= MERGE_STEP:
                            pairs.add((a, b))
    return sorted(pairs)


def regions(indices: list[int], links: list[tuple[int, int]]) -> list[list[int]]:
    """The given polygons in connected groups: polygons that meet across an edge are in the same one."""
    near: dict[int, list[int]] = {i: [] for i in indices}
    for a, b in links:
        if a in near and b in near:
            near[a].append(b)
            near[b].append(a)
    groups, done = [], set()
    for first in indices:
        if first in done:
            continue
        done.add(first)
        group, stack = [], [first]
        while stack:
            i = stack.pop()
            group.append(i)
            for j in near[i]:
                if j not in done:
                    done.add(j)
                    stack.append(j)
        groups.append(group)
    return groups


def holes(region: list[np.ndarray], radius: float) -> list[np.ndarray]:
    """Squares (cells of the 32-unit grid) filling the holes and gaps in a region's floor: the nav mesh walks round
    pillars and props, and in an open interior their cover would stand on over them. Holes up to HOLE_CELLS cells, and
    gaps a closing of CLOSE_CELLS fills; each cell at the height of the floor around it."""
    tri, _ = fans(region)
    cell, _, z = cell_samples(tri, radius, INTERIOR_CELL)
    if not len(cell):
        return []
    n = int(np.ceil(2 * radius / INTERIOR_CELL))
    gx, gy = cell % n, cell // n
    # The region's box, with room round it for the closing to work in: nothing outside the floor is filled.
    m = CLOSE_CELLS + 1
    x0, y0 = gx.min() - m, gy.min() - m
    w, h = gx.max() - x0 + m + 1, gy.max() - y0 + m + 1
    low = np.full(h * w, np.inf)
    np.minimum.at(low, (gy - y0) * w + (gx - x0), z)
    covered = np.isfinite(low).reshape(h, w)
    height = np.where(covered, low.reshape(h, w), 0.0)
    steps = ((1, 0), (-1, 0), (0, 1), (0, -1))
    outside = np.zeros((h, w), bool)  # open cells reachable from the edge of the region's box
    stack = [(y, x) for y in range(h) for x in (0, w - 1)] + [(y, x) for x in range(w) for y in (0, h - 1)]
    while stack:
        y, x = stack.pop()
        if 0 <= y < h and 0 <= x < w and not covered[y, x] and not outside[y, x]:
            outside[y, x] = True
            stack += [(y + dy, x + dx) for dy, dx in steps]
    hole = ~covered & ~outside
    fill = np.zeros((h, w), bool)
    seen = np.zeros((h, w), bool)
    for y, x in zip(*np.nonzero(hole)):
        if seen[y, x]:
            continue
        seen[y, x] = True
        members, stack = [], [(y, x)]
        while stack:
            cy, cx = stack.pop()
            members.append((cy, cx))
            for dy, dx in steps:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and hole[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        if len(members) <= HOLE_CELLS:
            fill[tuple(np.array(members).T)] = True
    r = CLOSE_CELLS
    disc = [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dy * dy + dx * dx <= r * r]

    def spread(grid: np.ndarray, dilate: bool) -> np.ndarray:  # dilation, or erosion; beyond the box is open
        pad = np.pad(grid, r, constant_values=False)
        moved = [pad[r + dy:r + dy + h, r + dx:r + dx + w] for dy, dx in disc]
        return np.any(moved, axis=0) if dilate else np.all(moved, axis=0)

    fill |= spread(spread(covered, True), False) & ~covered
    known, todo = covered.copy(), fill.copy()
    while todo.any():  # heights from the floor around, inwards
        total = np.pad(np.where(known, height, 0.0), 1)
        count = np.pad(known.astype(float), 1)
        s = sum(total[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx] for dy, dx in steps)
        c = sum(count[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx] for dy, dx in steps)
        now = todo & (c > 0)
        if not now.any():
            break
        height[now] = s[now] / c[now]
        known |= now
        todo &= ~now
    # Runs of cells along a row at about one height make one strip each.
    size, keep, out = INTERIOR_CELL, fill & known, []
    for y in range(h):
        x = 0
        while x < w:
            if not keep[y, x]:
                x += 1
                continue
            start = x
            while x + 1 < w and keep[y, x + 1] and abs(height[y, x + 1] - height[y, start]) < 8:
                x += 1
            z = float(height[y, start:x + 1].mean())
            a, b, wy = (x0 + start) * size - radius, (x0 + x + 1) * size - radius, (y0 + y) * size - radius
            out.append(np.array([[a, wy, z], [b, wy, z], [b, wy + size, z], [a, wy + size, z]]))
            x += 1
    return out


def interior_geometry(V: np.ndarray, T: np.ndarray, rooms: list[np.ndarray], radius: float) -> np.ndarray:
    """Per triangle: in an interior, so kept although no camera sees it (the 3D view opens interiors where heroes
    are). In an interior means within two grid cells of its polygons, from INTERIOR_BAND below their lowest floor
    there to INTERIOR_BAND above their highest: their floors and walls, not the cover above them."""
    if not rooms:
        return np.zeros(len(T), bool)
    n = int(np.ceil(2 * radius / INTERIOR_CELL))
    tri, _ = fans(rooms)
    cell, _, z = cell_samples(tri, radius, INTERIOR_CELL)
    lo = np.full(n * n, np.inf)
    hi = np.full(n * n, -np.inf)
    np.minimum.at(lo, cell, z)
    np.maximum.at(hi, cell, z)
    lo, hi = lo.reshape(n, n), hi.reshape(n, n)
    for _ in range(2):  # grow by two cells: walls stand where the walkable floor stops short of them
        lo_pad, hi_pad = np.pad(lo, 1, constant_values=np.inf), np.pad(hi, 1, constant_values=-np.inf)
        lo = np.min([lo_pad[1 + dy:n + 1 + dy, 1 + dx:n + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
        hi = np.max([hi_pad[1 + dy:n + 1 + dy, 1 + dx:n + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
    c = V[T].astype(np.float64).mean(1)
    cx = np.clip(((c[:, 0] + radius) / INTERIOR_CELL).astype(int), 0, n - 1)
    cy = np.clip(((c[:, 1] + radius) / INTERIOR_CELL).astype(int), 0, n - 1)
    return (c[:, 2] >= lo[cy, cx] + INTERIOR_BAND[0]) & (c[:, 2] <= hi[cy, cx] + INTERIOR_BAND[1])


def grown(polys: list[np.ndarray], by: float = INTERIOR_GROW) -> list[np.ndarray]:
    """Each polygon a little larger (its corners pushed out from its middle, on the map plane): nav polygons stop an
    agent's radius short of the walls, and the view opens the floor up to them."""
    out = []
    for p in polys:
        q = p.copy()
        d = q[:, :2] - q[:, :2].mean(0)
        q[:, :2] += d / np.maximum(np.linalg.norm(d, axis=1), 1e-6)[:, None] * by
        out.append(q)
    return out


# ---------------------------------------------------------------- colours from the render draw calls

class Materials:
    """A material's average albedo (linear RGB): its colour texture's reflectivity times its colour tint."""

    COLOR = ('g_tColor', 'g_tColor1', 'g_tColorA', 'g_tLayer1Color', 'TextureColor', 'g_tColor2')
    TINT = ('g_vColorTint', 'g_vColorTint1', 'g_vTint')

    def __init__(self, pak: Vpk):
        self.pak = pak
        self.cache: dict[str, np.ndarray | None] = {}

    def color(self, path: str):
        if path not in self.cache:
            self.cache[path] = self._color(path)
        return self.cache[path]

    def _color(self, path: str):
        try:
            m = kv3(blocks(self.pak.read(path + '_c'))['DATA'])
        except (KeyError, ValueError, struct.error, IndexError):
            return None
        tex = {p['m_name']: p['m_pValue'] for p in m.get('m_textureParams', [])}
        vec = {p['m_name']: np.asarray(p['m_value'], float) for p in m.get('m_vectorParams', [])}
        for name in self.COLOR:
            if tex.get(name, '') + '_c' in self.pak.entries:
                data = blocks(self.pak.read(tex[name] + '_c')).get('DATA')
                if not data:
                    continue
                c = np.array(struct.unpack_from('<3f', data, 4))
                tint = next((vec[t][:3] for t in self.TINT if t in vec), np.ones(3))
                return c * tint
        return None


def color_boxes(game: Vpk, pak: Vpk, map_name: str):
    """(min, max, linear RGB) of every render draw call of the map, from its world node and model meshes."""
    node = next(k for k in game.entries if k.startswith(f'maps/{map_name}/worldnodes/') and k.endswith('.vwnod_c'))
    world = kv3(blocks(game.read(node))['DATA'])
    materials = Materials(pak)
    models: dict[str, list] = {}

    def calls(path: str):
        if path not in models:
            models[path] = []
            if path + '_c' in game.entries:
                mdat = blocks(game.read(path + '_c')).get('MDAT')
                for so in (kv3(mdat).get('m_sceneObjects', []) if mdat else []):
                    bounds = so.get('m_drawBounds', [])
                    for i, dc in enumerate(so.get('m_drawCalls', [])):
                        b = bounds[i] if i < len(bounds) else so
                        models[path].append((dc.get('m_material', ''), np.asarray(dc.get('m_vTintColor', (1, 1, 1)), float)[:3],
                                             np.asarray(b['m_vMinBounds'], float), np.asarray(b['m_vMaxBounds'], float)))
        return models[path]

    lo, hi, rgb = [], [], []
    for agg in world['m_aggregateSceneObjects']:
        tints = {m['m_nDrawCallIndex']: np.asarray(m['m_vTintColor'], float)[:3] / 255 for m in agg['m_aggregateMeshes']}
        for i, (mat, tint, a, b) in enumerate(calls(agg['m_renderableModel'])):
            c = materials.color(mat)
            if c is not None:
                lo.append(a)
                hi.append(b)
                rgb.append(c * tint * tints.get(i, 1.0))
    for so in world['m_sceneObjects']:
        M = np.array([np.asarray(r, float) for r in so['m_vTransform']])
        tint = np.asarray(so['m_vTintColor'], float)[:3]
        for mat, dtint, a, b in calls(so['m_renderableModel']):
            c = materials.color(mat)
            if c is None:
                continue
            corners = np.array([[x, y, z] for x in (a[0], b[0]) for y in (a[1], b[1]) for z in (a[2], b[2])]) @ M[:, :3].T + M[:, 3]
            lo.append(corners.min(0))
            hi.append(corners.max(0))
            rgb.append(c * dtint * tint)
    # Near-black draw calls are glass and the like, whose look in the game is their reflections: as the smallest box
    # round a facade they would paint whole towers black, so the materials around them colour those walls instead.
    colours = np.array(rgb)
    keep = colours @ np.array([0.2126, 0.7152, 0.0722]) >= DARKEST
    return np.array(lo)[keep], np.array(hi)[keep], colours[keep], len(materials.cache)


def colors_for(tri: np.ndarray, lo: np.ndarray, hi: np.ndarray, rgb: np.ndarray, margin: float = 32.0) -> np.ndarray:
    """Each triangle's linear colour: the smallest box holding all of it, else the smallest holding its centre."""
    order = np.argsort(np.prod(np.maximum(hi - lo, 1.0), axis=1))
    lo, hi, rgb = lo[order] - margin, hi[order] + margin, rgb[order]
    cell = 512.0
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (a, b) in enumerate(zip(lo, hi)):
        for x in range(int(a[0] // cell), int(b[0] // cell) + 1):
            for y in range(int(a[1] // cell), int(b[1] // cell) + 1):
                grid.setdefault((x, y), []).append(i)
    out = np.full((len(tri), 3), np.nan)
    tlo, thi, centre = tri.min(1), tri.max(1), tri.mean(1)
    gx, gy = (centre[:, 0] // cell).astype(int), (centre[:, 1] // cell).astype(int)
    uniq, inv = np.unique(gx * 100003 + gy, return_inverse=True)
    for u in range(len(uniq)):
        members = np.nonzero(inv == u)[0]
        candidates = grid.get((int(gx[members[0]]), int(gy[members[0]])), [])
        whole = np.ones(len(members), bool)
        middle = np.ones(len(members), bool)
        for i in candidates:  # smallest first
            fits = whole & np.all((tlo[members] >= lo[i]) & (thi[members] <= hi[i]), axis=1)
            out[members[fits]] = rgb[i]
            whole &= ~fits
            middle &= ~fits
            near = middle & np.isnan(out[members, 0]) & np.all((centre[members] >= lo[i]) & (centre[members] <= hi[i]), axis=1)
            out[members[near]] = rgb[i]  # provisional, a later box that holds the whole triangle replaces it
            middle &= ~near
            if not whole.any():
                break
    out[np.isnan(out[:, 0])] = FALLBACK
    return out


# ---------------------------------------------------------------- ground heights for the markers

def ground_heights(V: np.ndarray, T: np.ndarray, radius: float, size: int, street: np.ndarray) -> np.ndarray:
    """Where markers stand in each cell (rows from the north). On the minimap's streets the lowest surface facing up
    (the street under bridges, awnings and the bases' domes), elsewhere the highest (a roof). Gaps are filled from
    their neighbours."""
    tri = V[T].astype(np.float64)
    n, _ = normals(tri)
    tri = tri[n[:, 2] > 0.5]
    z = tri[:, :, 2].mean(1)
    X = (tri[:, :, 0] + radius) / (2 * radius) * size
    Y = (radius - tri[:, :, 1]) / (2 * radius) * size

    def top(order) -> np.ndarray:  # painter's algorithm: what is drawn last wins
        img = Image.new('I', (size, size), -100000)
        draw = ImageDraw.Draw(img)
        for i in order:
            draw.polygon([(X[i, 0], Y[i, 0]), (X[i, 1], Y[i, 1]), (X[i, 2], Y[i, 2])], fill=int(z[i]))
        return np.asarray(img).astype(np.float64)

    walkable = np.asarray(Image.fromarray(street.astype('u1') * 255).resize((size, size))) > 127
    H = np.where(walkable, top(np.argsort(-z)), top(np.argsort(z)))
    H[H < -99999] = np.nan
    for _ in range(12):  # fill gaps from their neighbours
        if not np.isnan(H).any():
            break
        pad = np.pad(H, 1, constant_values=np.nan)
        near = np.stack([pad[1 + dy:size + 1 + dy, 1 + dx:size + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)  # cells with no neighbours yet stay empty this round
            H = np.where(np.isnan(H), np.nanmean(near, axis=0), H)
    H[np.isnan(H)] = np.nanmedian(H)
    pad = np.pad(H, 1, mode='edge')  # a light median keeps lamp posts and signs from lifting markers
    H = np.median(np.stack([pad[1 + dy:size + 1 + dy, 1 + dx:size + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)]), axis=0)
    return H


# ---------------------------------------------------------------- the game install, and putting it together

def find_game() -> Path | None:
    """Deadlock's install folder, through Steam's library list."""
    steam = []
    if sys.platform == 'win32':
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Valve\Steam') as k:
                steam.append(Path(winreg.QueryValueEx(k, 'SteamPath')[0]))
        except OSError:
            pass
    steam += [Path.home() / '.steam' / 'steam', Path.home() / '.local/share/Steam', Path.home() / 'Library/Application Support/Steam']
    for s in steam:
        libs = [s]
        vdf = s / 'steamapps' / 'libraryfolders.vdf'
        if vdf.exists():
            libs +=[Path(p.replace('\\\\', '\\')) for p in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text('utf-8', 'replace'))]
        for lib in libs:
            game = lib / 'steamapps' / 'common' / 'Deadlock'
            if (game / 'game' / 'citadel' / 'maps').is_dir():
                return game
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--game', type=Path, help="Deadlock's install folder (found through Steam if left out)")
    ap.add_argument('--map', default='dl_midtown')
    ap.add_argument('--quality', choices=CELLS, default='standard',
                    help="standard writes <map>.bin.gz; high writes <map>.high.bin.gz, for the 3D view's High quality")
    ap.add_argument('--cell', type=float, help="simplification grid in world units (larger is simpler; default: the quality's)")
    args = ap.parse_args()
    cell = args.cell or CELLS[args.quality]
    game_dir = args.game or find_game()
    if not game_dir:
        sys.exit('Deadlock not found: pass --game "<Steam library>/steamapps/common/Deadlock"')
    citadel = Path(game_dir) / 'game' / 'citadel'
    t0 = time.time()

    def step(msg):
        print(f'{time.time() - t0:6.1f}s  {msg}', flush=True)

    game = Vpk(citadel / 'maps' / f'{args.map}.vpk')
    pak = Vpk(citadel / 'pak01_dir.vpk')
    with urllib.request.urlopen(urllib.request.Request(ASSETS, headers=UA), timeout=60) as r:
        radius = float(json.load(r)['radius'])
    phys = kv3(blocks(game.read(f'maps/{args.map}/world_physics.vmdl_c'))['PHYS'])
    tri = world_triangles(phys, radius)
    step(f'{len(tri):,} solid triangles')
    closed, wide, street = playable_area(radius)
    tri = crop(tri, radius, closed, wide)
    step(f'{len(tri):,} in the playable area')
    arena = arena_box(tri)
    V, T = simplify(tri, cell)
    step(f'{len(T):,} after simplifying (cell {cell:g})')
    # Finer models get finer ID buffers, so their small triangles still win pixels where they are seen.
    seen = visible(V, T, radius, size=2048 if cell >= 64 else 4096)
    hidden_arena = in_arena(V, T, arena) & ~seen  # nothing sees into the arena, but the 3D view opens it
    nav = f'maps/{args.map}.nav'
    polys, links = nav_polygons(game.read(nav)) if nav in game.entries else ([], [])
    inner = interiors(polys, V, T, seen, radius)
    groups = [[polys[i] for i in g] for g in regions(inner, links + touching(polys, inner, radius))]
    groups = [g for g in groups if sum(floor_area(p) for p in g) >= MIN_ROOM]
    rooms = [p for g in groups for p in g]
    inside = interior_geometry(V, T, rooms, radius) & ~seen & ~hidden_arena  # nor into the others it opens
    keep = seen | hidden_arena | inside
    T, seen = T[keep], seen[keep]
    used, T = np.unique(T, return_inverse=True)
    V, T = V[used], T.reshape(-1, 3)
    step(f'{len(T):,} kept, {len(V):,} vertices: {int(hidden_arena.sum()):,} unseen in the Mid-Boss arena {arena}, '
         f'{int(inside.sum()):,} in {len(groups):,} interiors ({len(rooms):,} nav polygons)')
    lo, hi, rgb, n_materials = color_boxes(game, pak, args.map)
    step(f'{len(lo):,} draw call boxes from {n_materials} materials')
    linear = colors_for(V[T].astype(np.float64), lo, hi, rgb)
    srgb = np.clip(np.clip(linear, 0, 1) ** (1 / 2.2) * 255 + 0.5, 0, 255).astype('u1')
    # Markers stand on what can be seen: not on the arena's floor under the plaza.
    heights = ground_heights(V, T[seen], radius, HEIGHT_GRID, street)
    step('coloured, ground heights done')

    # Vertices in order of first use, so the indices compress well.
    first = np.full(len(V), len(T) * 3, np.int64)
    np.minimum.at(first, T.ravel(), np.arange(T.size))
    order = np.argsort(first)
    rank = np.empty_like(order)
    rank[order] = np.arange(len(order))
    V, T = V[order], rank[T]
    q = lambda v, a, b: np.clip(np.round((v - a) / (b - a) * 65535), 0, 65535).astype('<u2')
    out = bytearray(b'NMAP')
    out += struct.pack('<IfffIII', 3, radius, Z_MIN, Z_MAX, len(V), len(T), HEIGHT_GRID)
    out += np.stack([q(V[:, 0], -radius, radius), q(V[:, 1], -radius, radius), q(V[:, 2], Z_MIN, Z_MAX)], 1).tobytes()
    out += T.astype('<u4').tobytes()
    out += srgb.tobytes()
    out += q(heights, Z_MIN, Z_MAX).tobytes()
    out += struct.pack('<5f', *(arena or (0.0,) * 5))
    # Each interior's floor: its nav polygons, grown, and strips filling its holes and gaps.
    floors, owner = [], []
    for r, g in enumerate(groups):
        part = grown(g) + holes(g, radius)
        floors += part
        owner += [r] * len(part)
    corners = np.concatenate(floors) if floors else np.zeros((0, 3))
    first = np.cumsum([0] + [len(f) for f in floors])[:-1]
    fan = np.array([[s, s + k, s + k + 1] for s, f in zip(first, floors) for k in range(1, len(f) - 1)], '<u4').reshape(-1, 3)
    region = np.array([r for r, f in zip(owner, floors) for _ in range(1, len(f) - 1)], '<u2')
    out += struct.pack('<II', len(corners), len(fan))
    out += np.stack([q(corners[:, 0], -radius, radius), q(corners[:, 1], -radius, radius),
                     q(corners[:, 2], Z_MIN, Z_MAX)], 1).tobytes()
    out += fan.tobytes()
    out += region.tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / (f'{args.map}.bin.gz' if args.quality == 'standard' else f'{args.map}.{args.quality}.bin.gz')
    path.write_bytes(gzip.compress(bytes(out), 9, mtime=0))
    step(f'wrote {path.relative_to(ROOT)}: {path.stat().st_size / 1e6:.2f} MB ({len(out) / 1e6:.2f} MB unpacked)')


if __name__ == '__main__':
    main()
