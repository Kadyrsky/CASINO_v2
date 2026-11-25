"""Builds the models the realtime map's 3D view stands on the map: the lane guardians, the walkers, the base
guardians, the shrines, the patrons (the Hidden King and the Archmother) and the bridge power-ups, from the game's own
models, simplified and coloured from their textures in each team's colours.

    python scripts/map_objects.py            (from frontend/; Python 3.14+, numpy and Pillow, like map_model.py)
    python scripts/map_objects.py --game "D:/SteamLibrary/steamapps/common/Deadlock"

Reads the models from a local Deadlock install (found through Steam, or --game) and writes public/maps/objects.bin.gz,
the bridge power-ups' kinds (names, colours and minimap icons) to src/lib/powerupIcons.ts and the shrines' icon to
public/icons/objectives/shrine.webp. Run it again after a patch that changes them. Nothing is downloaded. The models,
icons and colours are Valve's, like the map.

How it works:
1. scripts/npc_units.vdata names each objective's model, its scale in the game and the material groups (skins) the
   game shows for each team: the guardian has "Amber" and "Sapphire"; the walker has none, so the Archmother's takes
   its "friendly" skin (a blue glow, the Hidden King's the default orange one); the base guardians are a different
   model per team. The shrines and patrons are a different model per team too, as the map's entities place them: each
   team's two shrines (destroyable_building) name their model and scale; each team's patron (npc_boss_tier3) names its
   unit, whose model stands at its first phase's scale. The bridge power-up is the crystal its particle effect draws,
   at the size and height it draws it.
2. A model's meshes: the draw calls of its first level of detail, with vertex and index buffers coded with
   meshoptimizer (and sometimes zstd) in their own blocks (MVTX, MIDX), or in the older combined block (MBUF). The
   vertices are in the model's rest pose, which is how they stand in the game's lanes and bases.
3. Each triangle is coloured from its material's colour texture where its middle lies, times the material's tint;
   self-illuminated parts (eyes, flames, candles) glow by their mask, tint and strength. What the game draws as light
   rather than as a surface is left out (see see_through). Then the mesh is simplified by vertex clustering, as the
   map is, each merged triangle taking the area-weighted colour of those it replaces.
4. Where each stands and which way it faces: the map's entities (guardian spawns, walkers, base guardians, shrines,
   patrons and the power-up spawners). The 3D view matches the frames' objectives and power-ups to these by position,
   for their facing and, in frames from bots older than heights, their height.
5. The bridge power-ups' kinds: the ones scripts/misc.vdata's spawner picks from (gun, survival, casting, movement),
   each with its colour (the game tints its crystal and icons with it), what it gives, its English name (from the
   game's localization) and its minimap icon (panorama/images/minimap, SVG). The crystal gets a skin in each kind's
   colour, and src/lib/powerupIcons.ts the rest, for the map's markers.
6. The shrines' icon for the map's markers: the game's picture of the shrine (panorama/images/npcs, from when shrines
   were "shield generators"), its glowing top cut out square, as a 64 px WebP like the other objectives' icons.

The file (little-endian, gzipped): magic "NOBJ", version 1 (u32), model count (u32); per model: name (u8 length,
ASCII), scale (f32: world units per model unit), vertex and triangle counts (u32), bounds (f32 × 3 min, × 3 max,
model units, from the spot it stands on: the power-up's floats above it), skin count (u32); the vertices as u16 x, y, z
quantized over the bounds (x forward, y left, z up, as in the game); the triangles as u16 vertex indices; per skin
its name (u8 length, ASCII), the triangles' sRGB colours (3 × u8) and how much each glows (u8, 0 lit like the map to
255 its own colour). Skins are named for teams ('0', '1'; one skin when the teams' look the same) and, the power-up's,
for its kinds ('gun' and so on, besides its untinted '0'). A team's own model (base_guardian_0, shrine_1, patron_0 and
so on) has one skin, '0'. Then the spawn count (u32) and per spawn: kind (u8 length, ASCII: guardian, walker,
base_guardian, shrine, patron or powerup), team (u8: 0 the Hidden King's, 1 the Archmother's, 255 none), x, y, z and
yaw (f32: world units and degrees).
"""
import argparse
import gzip
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from map_model import Vpk, blocks, find_game, kv3, lz4_into, normals, unzstd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'maps' / 'objects.bin.gz'
ICONS_OUT = ROOT / 'src' / 'lib' / 'powerupIcons.ts'
SHRINE_ICON_OUT = ROOT / 'public' / 'icons' / 'objectives' / 'shrine.webp'

# Each bridge power-up kind's minimap icon (panorama/images/minimap/powerup_<icon>.svg): the vdata names only its ping
# icon (hud/icons/powerup_gun.svg and so on), a bigger picture without the minimap's ring.
MINIMAP_ICONS = {'gun': 'weapon', 'survival': 'health', 'casting': 'magic', 'movement': 'movement'}
# What each of a power-up's modifier values is, in a few words (others: the value's name in lower case).
GIVES = {'FIRE_RATE': 'fire rate', 'AMMO_CLIP_SIZE_PERCENT': 'clip size', 'HEALTH_MAX': 'max health',
         'HEALTH_REGEN_PER_SECOND': 'health regen', 'TECH_POWER': 'spirit power',
         'COOLDOWN_REDUCTION_PERCENTAGE': 'cooldowns', 'STAMINA': 'stamina', 'SPRINT_SPEED_BONUS': 'sprint speed',
         'ZIP_LINE_SPEED_PERCENTAGE': 'zipline speed', 'STAMINA_REGEN_PER_SECOND_PERCENTAGE': 'stamina regen'}
# Colours darker than this (relative luminance) are lightened to it for the map, whose markers are dark: the movement
# power-up's deep blue would hardly show.
LEAST_LUMINANCE = 0.2

# The bridge power-up has no model of its own: this particle effect draws one, with its own material.
POWERUP_PARTICLE = 'particles/environment/powerup_spawner_ambient_breakable_model.vpcf'
# Triangles each model keeps. The 3D view draws all of them at once: 6 guardians, 6 walkers, 12 base guardians,
# 4 shrines and the 2 patrons (as tall as the buildings round them, so they keep more).
TARGET = {'guardian': 6000, 'walker': 6000, 'base_guardian_0': 4000, 'base_guardian_1': 4000, 'shrine_0': 4000,
          'shrine_1': 4000, 'patron_0': 8000, 'patron_1': 8000, 'powerup': 400}
# The shrines' picture (the game's unit icon from when they were "shield generators") and the part of it the icon
# shows: its glowing top (left, top, right, bottom as shares of the picture).
SHRINE_PICTURE = 'panorama/images/npcs/shield_generator_psd.vtex'
SHRINE_CROP = (0.26, 0.0, 0.89, 0.63)
ICON_SIZE = 64  # px, as scripts/wiki_icons.py makes the other objectives' icons
TEXTURE_SIZE = 512  # colour textures are read at the largest mip no wider than this
MASK_SIZE = 64  # and self-illumination masks at this
# The power-up's particle effect makes its crystal self-illuminated (its colour, which the game sets for each kind of
# power-up, isn't in the frames): how much it glows.
POWERUP_GLOW = 0.55
TEAMS = {'2': 0, '3': 1}  # the game's team numbers -> the frames' (0 the Hidden King, Amber; 1 the Archmother, Sapphire)


# ---------------------------------------------------------------- meshoptimizer's vertex and index codecs

def _unzigzag(v: np.ndarray) -> np.ndarray:
    return (-(v & 1)) ^ (v >> 1)


def _byte_group(data: memoryview, pos: int, out: np.ndarray, at: int, bits: int) -> int:
    """One group of 16 bytes packed `bits` wide; values of all ones are escapes, their byte following the packed
    ones. Returns where the next group starts."""
    if bits == 0:
        out[at:at + 16] = 0
        return pos
    if bits == 8:
        out[at:at + 16] = np.frombuffer(data[pos:pos + 16], np.uint8)
        return pos + 16
    extra = pos + 16 * bits // 8
    top = (1 << bits) - 1
    per = 8 // bits
    for i in range(16):
        byte = data[pos + i // per]
        if bits == 1:
            v = (byte >> (i % 8)) & 1  # 1-bit values go from the low bit up
        else:
            v = (byte >> (8 - bits * (i % per + 1))) & top  # 2- and 4-bit values from the high bits down
        if v == top:
            v = data[extra]
            extra += 1
        out[at + i] = v
    return extra


def meshopt_vertices(data: bytes, count: int, size: int) -> bytes:
    """meshoptimizer's vertex codec (versions 0 and 1): blocks of vertices, each byte of a vertex coded across the
    block as deltas from the vertex before, packed 0 to 8 bits wide."""
    if data[0] & 0xF0 != 0xA0 or data[0] & 0x0F > 1:
        raise ValueError('not a meshoptimizer vertex buffer')
    version = data[0] & 0x0F
    body = memoryview(data)[1:]
    tail = size + (size // 4 if version else 0)
    last = np.frombuffer(body[len(body) - tail:len(body) - tail + size], np.uint8).copy()
    channels = bytes(body[len(body) - tail + size:len(body) - tail + size + size // 4]) if version else bytes(size // 4)
    block = min((8192 // size) & ~15, 256)
    out = np.empty((count, size), np.uint8)
    pos = 0
    for start in range(0, count, block):
        n = min(block, count - start)
        aligned = (n + 15) & ~15
        control = bytes(body[pos:pos + size // 4]) if version else bytes(size // 4)
        pos += size // 4 if version else 0
        for k in range(0, size, 4):
            lanes = np.zeros((4, aligned), np.uint8)
            for j in range(4):
                mode = (control[k // 4] >> (2 * j)) & 3
                if mode == 3:  # literal
                    lanes[j, :n] = np.frombuffer(body[pos:pos + n], np.uint8)
                    pos += n
                elif mode == 2:  # zeros
                    continue
                else:
                    widths = (0, 2, 4, 8) if version == 0 else (0, 1, 2, 4, 8)[mode:mode + 4]
                    groups = aligned // 16
                    header = body[pos:pos + (groups + 3) // 4]
                    pos += (groups + 3) // 4
                    for g in range(groups):
                        pos = _byte_group(body, pos, lanes[j], g * 16, widths[(header[g // 4] >> ((g % 4) * 2)) & 3])
            lanes = lanes[:, :n]
            channel = channels[k // 4]
            if channel & 3 == 0:  # bytes: zigzag deltas
                for j in range(4):
                    d = _unzigzag(lanes[j].astype(np.int64))
                    out[start:start + n, k + j] = (int(last[k + j]) + np.cumsum(d)) & 0xFF
            elif channel & 3 == 1:  # 16-bit words: zigzag deltas
                for j in (0, 2):
                    d = _unzigzag(lanes[j].astype(np.int64) | (lanes[j + 1].astype(np.int64) << 8))
                    v = (int(last[k + j]) | (int(last[k + j + 1]) << 8)) + np.cumsum(d)
                    out[start:start + n, k + j] = v & 0xFF
                    out[start:start + n, k + j + 1] = (v >> 8) & 0xFF
            elif channel & 3 == 2:  # 32-bit words: rotated xor deltas
                rot = (32 - (channel >> 4)) & 31
                w = (lanes[0].astype(np.uint32) | (lanes[1].astype(np.uint32) << 8)
                     | (lanes[2].astype(np.uint32) << 16) | (lanes[3].astype(np.uint32) << 24))
                if rot:
                    w = (w << np.uint32(rot)) | (w >> np.uint32(32 - rot))
                p = int(last[k]) | (int(last[k + 1]) << 8) | (int(last[k + 2]) << 16) | (int(last[k + 3]) << 24)
                v = np.bitwise_xor.accumulate(np.concatenate([np.array([p], np.uint32), w]))[1:]
                for j in range(4):
                    out[start:start + n, k + j] = (v >> np.uint32(8 * j)) & 0xFF
            else:
                raise ValueError('bad meshoptimizer channel')
        last = out[start + n - 1].copy()
    if len(body) - pos != max(tail, 24 if version else 32):
        raise ValueError('meshoptimizer vertex buffer: wrong length')
    return out.tobytes()


def _vbyte(data: bytes, pos: int) -> tuple[int, int]:
    lead = data[pos]
    pos += 1
    if lead < 128:
        return lead, pos
    result, shift = lead & 127, 7
    for _ in range(4):
        group = data[pos]
        pos += 1
        result |= (group & 127) << shift
        shift += 7
        if group < 128:
            break
    return result, pos


def meshopt_indices(data: bytes, count: int) -> np.ndarray:
    """meshoptimizer's index codec (versions 0 and 1): triangles coded against FIFOs of recent edges and vertices."""
    if data[0] & 0xF0 != 0xE0 or data[0] & 0x0F > 1:
        raise ValueError('not a meshoptimizer index buffer')
    version = data[0] & 0x0F
    tris = count // 3
    code = data[1:1 + tris]
    body = data[1 + tris:]
    aux = body[len(body) - 16:]
    m = 0xFFFFFFFF
    pos = 0
    edges = [(0, 0)] * 16
    verts = [0] * 16
    eo = vo = nxt = last = 0
    fecmax = 13 if version >= 1 else 15
    out = np.empty(tris * 3, np.uint32)

    def free(last: int, pos: int) -> tuple[int, int]:
        v, pos = _vbyte(body, pos)
        return (last + ((v >> 1) ^ -(v & 1))) & m, pos

    for t, codetri in enumerate(code):
        if codetri < 0xF0:
            a, b = edges[(eo - 1 - (codetri >> 4)) & 15]
            fec = codetri & 15
            if fec < fecmax:
                c = nxt if fec == 0 else verts[(vo - 1 - fec) & 15]
                verts[vo] = c  # written always, kept (the FIFO moved on) only for a new vertex
                if fec == 0:
                    vo = (vo + 1) & 15
                    nxt += 1
            else:
                if fec != 15:
                    c = last = (last + fec * 2 - 27) & m
                else:
                    c, pos = free(last, pos)
                    last = c
                verts[vo] = c
                vo = (vo + 1) & 15
            edges[eo] = (c, b)
            edges[(eo + 1) & 15] = (a, c)
            eo = (eo + 2) & 15
        else:
            if codetri < 0xFE:
                codeaux = aux[codetri & 15]
                fea = 0
            else:
                codeaux = body[pos]
                pos += 1
                fea = 0 if codetri == 0xFE else 15
                if codeaux == 0:
                    nxt = 0
            feb, fec = codeaux >> 4, codeaux & 15
            if fea == 0:
                a = nxt
                nxt += 1
            else:
                a = 0
            if feb == 0:
                b = nxt
                nxt += 1
            else:
                b = verts[(vo - feb) & 15]
            if fec == 0:
                c = nxt
                nxt += 1
            else:
                c = verts[(vo - fec) & 15]
            if fea == 15:
                a, pos = free(last, pos)
                last = a
            if feb == 15:
                b, pos = free(last, pos)
                last = b
            if fec == 15:
                c, pos = free(last, pos)
                last = c
            verts[vo] = a
            vo = (vo + 1) & 15
            verts[vo] = b
            vo = (vo + (feb == 0 or feb == 15)) & 15
            verts[vo] = c
            vo = (vo + (fec == 0 or fec == 15)) & 15
            edges[eo] = (b, a)
            edges[(eo + 1) & 15] = (c, b)
            edges[(eo + 2) & 15] = (a, c)
            eo = (eo + 3) & 15
        out[3 * t:3 * t + 3] = (a, b, c)
    if pos != len(body) - 16:
        raise ValueError('meshoptimizer index buffer: wrong length')
    return out


# ---------------------------------------------------------------- models: buffers, draw calls, materials

# The DXGI vertex formats read here: (type, components, scale to the value).
FORMATS = {2: ('<f4', 4, 1.0), 6: ('<f4', 3, 1.0), 16: ('<f4', 2, 1.0), 10: ('<f2', 4, 1.0), 34: ('<f2', 2, 1.0),
           35: ('<u2', 2, 1 / 65535), 37: ('<i2', 2, 1 / 32767), 11: ('<u2', 4, 1 / 65535), 13: ('<i2', 4, 1 / 32767)}


class Buffer:
    def __init__(self, count: int, size: int, layout: dict[str, tuple[int, int]], data: bytes):
        self.count, self.size, self.layout, self.data = count, size, layout, data

    def attribute(self, name: str) -> np.ndarray:
        fmt, offset = self.layout[name]
        if fmt not in FORMATS:
            raise ValueError(f'{name}: vertex format {fmt} is not read here')
        dtype, n, scale = FORMATS[fmt]
        rows = np.frombuffer(self.data, np.uint8).reshape(self.count, self.size)
        values = rows[:, offset:offset + np.dtype(dtype).itemsize * n].copy().view(dtype).reshape(self.count, n)
        return values.astype(np.float64) * scale


def _unpack(raw: bytes, count: int, size: int, vertex: bool, meshopt: bool, zstd: bool) -> bytes:
    if zstd:
        raw = unzstd(raw)
    if not meshopt:
        return raw
    if vertex:
        return meshopt_vertices(raw, count, size)
    return meshopt_indices(raw, count).astype('<u4' if size == 4 else '<u2').tobytes()


def kv_buffer(desc: dict, raw_blocks: list[bytes], vertex: bool) -> Buffer:
    """A buffer described in KeyValues: newer models, its data in its own block (MVTX, MIDX)."""
    count, size = int(desc['m_nElementCount']), int(desc['m_nElementSizeInBytes'])
    layout = {}
    for f in desc.get('m_inputLayoutFields', []):
        name = f['m_pSemanticName']
        name = (bytes(name).decode() if isinstance(name, (bytes, bytearray)) else name).rstrip('\0').upper()
        layout.setdefault(f'{name}{int(f["m_nSemanticIndex"]) or ""}', (int(f['m_Format']), int(f['m_nOffset'])))
    if desc.get('m_bCompressedZ3'):
        raise ValueError('z3-compressed mesh buffers are not read here')
    if int(desc.get('m_nBlockIndex', -1)) < 0:
        raw = bytes(desc['m_pData'])
        data = raw if len(raw) == count * size else _unpack(raw, count, size, vertex, True, False)
    else:
        raw = raw_blocks[int(desc['m_nBlockIndex'])]
        data = _unpack(raw, count, size, vertex, bool(desc.get('m_bMeshoptCompressed')), bool(desc.get('m_bCompressedZSTD')))
    return Buffer(count, size, layout, data)


def vbib_buffers(data: bytes) -> tuple[list[Buffer], list[Buffer]]:
    """The older combined buffer block (VBIB, named MBUF in newer files): binary headers, then the data."""
    vb_off, vb_count, ib_off, ib_count = struct.unpack_from('<IIII', data, 0)

    def read(at: int, vertex: bool) -> Buffer:
        count, flags = struct.unpack_from('<Ii', data, at)
        size = flags & 0x3FFFFFF
        attr_off, attr_count = struct.unpack_from('<II', data, at + 8)
        data_off, total = struct.unpack_from('<Ii', data, at + 16)
        layout = {}
        for i in range(attr_count):
            p = at + 8 + attr_off + 56 * i
            name = data[p:p + 32].split(b'\0')[0].decode().upper()
            index, fmt, offset = struct.unpack_from('<iII', data, p + 32)
            layout.setdefault(f'{name}{index or ""}', (fmt, offset))
        raw = data[at + 16 + data_off:at + 16 + data_off + total]
        packed = count * size > total
        return Buffer(count, size, layout, _unpack(raw, count, size, vertex, packed and not flags & 0x4000000, packed and bool(flags & 0x8000000)))

    return ([read(vb_off + 24 * i, True) for i in range(vb_count)],
            [read(8 + ib_off + 24 * i, False) for i in range(ib_count)])


def all_blocks(data: bytes) -> list[tuple[str, bytes]]:
    """Every block of a compiled resource, in order (meshes refer to theirs by index)."""
    _size, _hv, _v, offset, count = struct.unpack_from('<IHHII', data, 0)
    out = []
    p = 8 + offset
    for _ in range(count):
        kind = data[p:p + 4].decode('ascii', 'replace')
        rel, size = struct.unpack_from('<II', data, p + 4)
        out.append((kind, data[p + 4 + rel:p + 4 + rel + size]))
        p += 12
    return out


class Model:
    """A model's first level of detail: vertex positions and texture coordinates, its triangles, and each
    triangle's material (an index into `materials`, the default skin's)."""

    def __init__(self, pak: Vpk, path: str):
        listed = all_blocks(pak.read(path + '_c'))
        raw = [b for _, b in listed]
        kinds = [k for k, _ in listed]
        ctrl = kv3(raw[kinds.index('CTRL')])
        info = kv3(raw[kinds.index('DATA')])
        lods = list(info.get('m_refLODGroupMasks', [])) or [1]
        self.groups = {g['m_name']: list(g['m_materials']) for g in info.get('m_materialGroups', [])}
        self.materials: list[str] = []
        P, UV, tris, mats = [], [], [], []
        base = 0
        for mesh in ctrl['embedded_meshes']:
            # Newer files name these m_nMeshIndex, m_nVBIBBlock and m_nDataBlock; older ones mesh_index and so on.
            index = int(mesh.get('m_nMeshIndex', mesh.get('mesh_index', 0)))
            if not int(lods[index] if index < len(lods) else 1) & 1:
                continue  # not in the first level of detail
            vbib = int(mesh.get('m_nVBIBBlock', mesh.get('vbib_block', -1)))
            if vbib >= 0:
                vbs, ibs = vbib_buffers(raw[vbib])
            else:
                vbs = [kv_buffer(d, raw, True) for d in mesh['m_vertexBuffers']]
                ibs = [kv_buffer(d, raw, False) for d in mesh['m_indexBuffers']]
            mdat = kv3(raw[int(mesh.get('m_nDataBlock', mesh.get('data_block', -1)))])
            for so in mdat['m_sceneObjects']:
                for dc in so['m_drawCalls']:
                    if dc.get('m_nPrimitiveType', 'RENDER_PRIM_TRIANGLES') != 'RENDER_PRIM_TRIANGLES':
                        continue
                    vb = vbs[int(dc['m_vertexBuffers'][0]['m_hBuffer'])]
                    ib = ibs[int(dc['m_indexBuffer']['m_hBuffer'])]
                    first = int(dc['m_vertexBuffers'][0].get('m_nBindOffsetBytes', 0)) // vb.size
                    idx = np.frombuffer(ib.data, '<u4' if ib.size == 4 else '<u2').astype(np.int64)
                    start = int(dc['m_indexBuffer'].get('m_nBindOffsetBytes', 0)) // ib.size + int(dc['m_nStartIndex'])
                    idx = idx[start:start + int(dc['m_nIndexCount'])] + int(dc.get('m_nBaseVertex', 0)) + first
                    used, local = np.unique(idx, return_inverse=True)
                    P.append(vb.attribute('POSITION')[used, :3])
                    UV.append(vb.attribute('TEXCOORD')[used, :2] if 'TEXCOORD' in vb.layout else np.zeros((len(used), 2)))
                    tris.append(local.reshape(-1, 3) + base)
                    material = dc.get('m_material', '')
                    if material not in self.materials:
                        self.materials.append(material)
                    mats.append(np.full(len(local) // 3, self.materials.index(material)))
                    base += len(used)
        self.P, self.UV = np.concatenate(P), np.concatenate(UV)
        self.T, self.mat = np.concatenate(tris), np.concatenate(mats)

    def skin(self, group: str | None) -> list[str]:
        """The materials in a material group (a skin): each takes the place of the default group's at its position."""
        default = next(iter(self.groups.values()), [])
        swap = dict(zip(default, self.groups.get(group, default))) if group else {}
        return [swap.get(m, m) for m in self.materials]


# ---------------------------------------------------------------- textures and colours

def texture(pak: Vpk, path: str, srgb: bool = True, largest: int = TEXTURE_SIZE) -> np.ndarray:
    """A texture's largest mip no wider than `largest` as RGB floats (rows, columns, 3), linear if `srgb`."""
    rgb = np.asarray(picture(pak, path, largest).convert('RGB'), np.float64) / 255
    return rgb ** 2.2 if srgb else rgb


def picture(pak: Vpk, path: str, largest: int = TEXTURE_SIZE) -> Image.Image:
    """A texture's largest mip no wider than `largest`, as an image (its own mode: RGBA, RGB or L)."""
    data = pak.read(path + '_c')
    _size, _hv, _v, offset, count = struct.unpack_from('<IHHII', data, 0)
    p = 8 + offset
    for _ in range(count):  # the DATA block holds the header; the pixels follow it, smallest mip first
        rel, size = struct.unpack_from('<II', data, p + 4)
        if data[p:p + 4] == b'DATA':
            head_at, head_size = p + 4 + rel, size
        p += 12
    head = data[head_at:head_at + head_size]
    width, height, depth, fmt, mips = struct.unpack_from('<HHHBB', head, 20)
    extra_off, extra_count = struct.unpack_from('<II', head, 32)
    compressed = None
    q = 32 + extra_off
    for _ in range(extra_count):
        kind, off, _size = struct.unpack_from('<III', head, q)
        if kind == 4:  # the mips' compressed sizes
            at = q + 4 + off
            _method, mips_off, n = struct.unpack_from('<III', head, at)
            compressed = struct.unpack_from(f'<{n}i', head, at + 4 + mips_off)
        q += 12
    # Block-compressed formats: bytes per 4 × 4 block, Pillow's image mode and decoder number.
    bcn = {1: (8, 'RGBA', 1), 2: (16, 'RGBA', 3), 20: (16, 'RGBA', 7), 27: (8, 'L', 4), 21: (16, 'RGB', 5)}.get(fmt)
    block = bcn[0] if bcn else None  # DXT1, DXT5, BC7, BC4 (ATI1N: masks), BC5 (ATI2N)
    if not block and fmt not in (4, 28):  # RGBA8888, BGRA8888
        raise ValueError(f'texture format {fmt} is not read here')

    def size_of(level: int) -> int:
        w, h = max(width >> level, 1), max(height >> level, 1)
        return ((w + 3) // 4) * ((h + 3) // 4) * block * depth if block else w * h * depth * 4

    want = 0
    while want < mips - 1 and max(width >> want, 1) > largest:
        want += 1
    pos = head_at + head_size
    for level in range(mips - 1, want, -1):
        pos += min(size_of(level), compressed[level]) if compressed else size_of(level)
    if compressed and compressed[want] < size_of(want):
        raw = bytes(lz4_into(data[pos:pos + compressed[want]], bytearray()))
    else:
        raw = data[pos:pos + size_of(want)]
    w, h = max(width >> want, 1), max(height >> want, 1)
    if block:
        padded = ((w + 3) // 4 * 4, (h + 3) // 4 * 4)
        return Image.frombuffer(bcn[1], padded, raw[:size_of(want) // depth], 'bcn', bcn[2], '').crop((0, 0, w, h))
    return Image.frombuffer('RGBA', (w, h), raw[:w * h * 4], 'raw', 'BGRA' if fmt == 28 else 'RGBA', 0, 1)


def see_through(path: str, flags: dict[str, int]) -> bool:
    """Whether the game draws a material as light rather than as a surface, so the map leaves it out: occluders (they
    only hide what is behind them; the game doesn't draw them), additive blends, and shafts of light (the beams from
    the Hidden King's eyes and over the Archmother's shrine's book, see-through in the game, would be solid blocks
    here). Translucency alone isn't enough: the Archmother's robes are translucent."""
    name = path.lower()
    return 'occluder' in name or 'light_beam' in name or bool(flags.get('F_ADDITIVE_BLEND'))


class Look:
    """What a material shows: its colour texture times its tint, and its self-illumination (mask, colour, strength)."""

    COLOURS = ('g_tColor', 'g_tColor1', 'g_tColorA', 'g_tLayer1Color', 'TextureColor', 'g_tColor2')
    TINTS = ('g_vColorTint1', 'g_vColorTint', 'g_vTint')

    def __init__(self, pak: Vpk, path: str):
        self.colour = self.mask = None
        self.tint, self.glow_tint, self.glow, self.glow_albedo = np.ones(3), np.zeros(3), 0.0, False
        self.hidden = see_through(path, {})
        try:
            m = kv3(blocks(pak.read(path + '_c'))['DATA'])
        except (KeyError, ValueError, struct.error, IndexError) as e:
            print(f'        {path}: {e}', file=sys.stderr)
            return
        tex = {p['m_name']: p['m_pValue'] for p in m.get('m_textureParams', [])}
        vec = {p['m_name']: np.asarray(p['m_value'], float)[:3] for p in m.get('m_vectorParams', [])}
        num = {p['m_name']: float(p['m_flValue']) for p in m.get('m_floatParams', [])}
        ints = {p['m_name']: int(p['m_nValue']) for p in m.get('m_intParams', [])}
        self.hidden = see_through(path, ints)
        self.tint = next((vec[t] for t in self.TINTS if t in vec), np.ones(3))
        name = next((tex[t] for t in self.COLOURS if tex.get(t, '') + '_c' in pak.entries), None)
        if name:
            self.colour = texture(pak, name)
        if ints.get('F_SELF_ILLUM'):
            self.glow = num.get('g_flSelfIllumScale1', num.get('g_flSelfIllumScale', 1.0))
            self.glow_tint = vec.get('g_vSelfIllumTint1', vec.get('g_vSelfIllumTint', np.ones(3)))
            self.glow_albedo = num.get('g_flSelfIllumAlbedoFactor1', 0.0) >= 0.5
            if tex.get('g_tSelfIllumMask', '') + '_c' in pak.entries:
                # A small mip: each texel the share of its patch that glows. Masks are often thin line art (runes,
                # rings) that a triangle's middle would hit or miss.
                self.mask = texture(pak, tex['g_tSelfIllumMask'], srgb=False, largest=MASK_SIZE)


def sample(image: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w, _ = image.shape
    x = np.floor(uv[:, 0] % 1.0 * w).astype(int) % w
    y = np.floor(uv[:, 1] % 1.0 * h).astype(int) % h
    return image[y, x]


def face_colours(model: Model, looks: list[Look]):
    """Each triangle's linear colour and glow (0 to 1), from its material where the triangle's middle lies; and
    which triangles the game draws at all."""
    uv = model.UV[model.T].mean(1)
    colour = np.full((len(model.T), 3), 0.36)
    glow = np.zeros(len(model.T))
    shown = np.ones(len(model.T), bool)
    for i, look in enumerate(looks):
        sel = model.mat == i
        if look.hidden:
            shown[sel] = False
            continue
        albedo = (sample(look.colour, uv[sel]) if look.colour is not None else np.full((sel.sum(), 3), 0.36)) * look.tint
        colour[sel] = albedo
        if look.glow > 0 and look.glow_tint.max() > 0:
            # How much of the triangle glows (its mask), as bright as the material makes it, at most fully: the game's
            # strength (up to 10) is for its bloom; here a glowing triangle simply shows the glow's colour unlit.
            mask = sample(look.mask, uv[sel]).max(1) if look.mask is not None else np.ones(sel.sum())
            light = look.glow_tint * (albedo if look.glow_albedo else 1.0)
            strength = np.clip(mask, 0, 1) * np.clip(look.glow * light.max(axis=-1), 0, 1)
            hue = light / np.maximum(light.max(axis=-1, keepdims=True), 1e-6)
            colour[sel] = albedo * (1 - strength[:, None]) + hue * strength[:, None]
            glow[sel] = strength
    return colour, glow, shown


# ---------------------------------------------------------------- simplification that keeps the colours

def simplify(P: np.ndarray, T: np.ndarray, colours: list[np.ndarray], cell: float):
    """Vertex clustering on a grid of `cell` model units, each cell's vertex where it best fits its triangles' planes
    (as map_model.simplify, keeping faces of every direction). `colours` are per-triangle arrays (each skin's colours
    and glows), merged triangles taking the area-weighted mean of those they replace."""
    tri = P[T]
    n, area = normals(tri)
    keep = area > 1e-9
    tri, n, area, T = tri[keep], n[keep], area[keep], T[keep]
    colours = [c[keep] for c in colours]
    pts = tri.reshape(-1, 3)
    key = np.floor(pts / cell).astype(np.int64) + (1 << 20)
    k = (key[:, 0] << 42) | (key[:, 1] << 21) | key[:, 2]
    uniq, inv = np.unique(k, return_inverse=True)
    cells = len(uniq)
    q = np.concatenate([n, -np.einsum('ij,ij->i', n, tri[:, 0])[:, None]], 1)
    Q = np.repeat((area[:, None, None] * q[:, :, None] * q[:, None, :]).reshape(-1, 16), 3, axis=0)
    acc = np.zeros((cells, 16))
    np.add.at(acc, inv, Q)
    mean = np.zeros((cells, 3))
    np.add.at(mean, inv, pts)
    mean /= np.bincount(inv, minlength=cells)[:, None]
    A = acc[:, [0, 1, 2, 4, 5, 6, 8, 9, 10]].reshape(-1, 3, 3)
    lam = 1e-3 * np.trace(A, axis1=1, axis2=2)[:, None, None] + 1e-9
    best = np.linalg.solve(A + lam * np.eye(3), (-acc[:, [3, 7, 11]] + lam[:, :, 0] * mean)[:, :, None])[:, :, 0]
    lo = (((uniq[:, None] >> np.array([42, 21, 0])) & ((1 << 21) - 1)) - (1 << 20)) * cell
    near = np.all((best > lo - 0.25 * cell) & (best < lo + 1.25 * cell), axis=1)
    V = np.where(near[:, None], best, mean)
    C = inv.reshape(-1, 3)
    ok = (C[:, 0] != C[:, 1]) & (C[:, 1] != C[:, 2]) & (C[:, 0] != C[:, 2])
    C, area, colours = C[ok], area[ok], [c[ok] for c in colours]
    groups, first, which = np.unique(np.sort(C, axis=1), axis=0, return_index=True, return_inverse=True)
    which = which.ravel()
    weight = np.bincount(which, weights=area, minlength=len(groups))
    merged = []
    for c in colours:
        c2 = c.reshape(len(c), -1)
        out = np.stack([np.bincount(which, weights=area * c2[:, j], minlength=len(groups)) for j in range(c2.shape[1])], 1)
        merged.append((out / np.maximum(weight, 1e-12)[:, None]).reshape((len(groups),) + c.shape[1:]))
    F = C[first]  # each merged triangle keeps the winding of its first original
    used, F = np.unique(F, return_inverse=True)
    return V[used], F.reshape(-1, 3), merged


def simplified(P: np.ndarray, T: np.ndarray, colours: list[np.ndarray], target: int):
    """The coarsest-needed clustering that leaves at most `target` triangles (the model as it is when it has fewer)."""
    if len(T) <= target:
        used, F = np.unique(T, return_inverse=True)
        return P[used], F.reshape(-1, 3), colours
    size = np.ptp(P, axis=0).max()
    lo, hi = size / 2000, size / 10
    best = simplify(P, T, colours, hi)
    for _ in range(14):  # bisect on the cell size (in log space)
        mid = (lo * hi) ** 0.5
        trial = simplify(P, T, colours, mid)
        if len(trial[1]) <= target:
            best, hi = trial, mid
        else:
            lo = mid
    return best


# ---------------------------------------------------------------- the models and where they stand

def objective_models(pak: Vpk, entities: list[dict]) -> list[dict]:
    """Each model to write: its name, file, scale, lift and skins (name -> material group). `entities`: the map's
    (see map_entities), which place the shrines and patrons."""
    npc = kv3(blocks(pak.read('scripts/npc_units.vdata_c'))['DATA'])

    def unit(key: str) -> dict:
        e = npc[key]
        return {'path': e['m_sModelName'], 'scale': float(e.get('m_flModelScale', 1.0)), 'lift': 0.0, 'material': None,
                'team_groups': (e.get('m_sTeam1MaterialGroupName') or 'Amber', e.get('m_sTeam2MaterialGroupName') or 'Sapphire')}

    guardian, walker = unit('npc_boss_tier1'), unit('npc_boss_tier2')
    out = []
    for name, u in (('guardian', guardian), ('walker', walker)):
        out.append({'name': name, **u, 'skins': {'0': u['team_groups'][0], '1': u['team_groups'][1]}})
    for team, key in (('0', 'npc_barrack_boss_amber'), ('1', 'npc_barrack_boss_sapphire')):
        out.append({'name': f'base_guardian_{team}', **unit(key), 'skins': {'0': None}})
    out += team_models(npc, entities)
    # The power-up: its particle effect's model, material, size (the particles' radius) and height above its spawner.
    fx = kv3(blocks(pak.read(POWERUP_PARTICLE + '_c'))['DATA'])
    renderer = next(r for r in fx['m_Renderers'] if r.get('_class') == 'C_OP_RenderModels')
    radius = next((float(i['m_InputValue']['m_flLiteralValue']) for i in fx['m_Initializers']
                   if i['_class'] == 'C_INIT_InitFloat' and i.get('m_nOutputField') == 1
                   and i['m_InputValue'].get('m_nType') == 'PF_TYPE_LITERAL'), 1.0)
    lift = next((float(i['m_OffsetMin']['m_vLiteralValue'][2]) for i in fx['m_Initializers']
                 if i['_class'] == 'C_INIT_PositionOffset'), 0.0)
    glows = any(v.get('m_strVariable') == '$SELFILLUM' for v in renderer.get('m_MaterialVars', []))
    out.append({'name': 'powerup', 'path': renderer['m_ModelList'][0]['m_model'], 'scale': radius, 'lift': lift,
                'material': renderer.get('m_hOverrideMaterial') or None, 'skins': {'0': None},
                'glow': POWERUP_GLOW if glows else 0.0})
    return out


def team_models(npc: dict, entities: list[dict]) -> list[dict]:
    """Each team's shrine and patron model (shrine_0, shrine_1, patron_0, patron_1), as the map places them: a shrine's
    entity names its model and scale; a patron's names its unit (the Archmother's is "alt_npc_boss_tier3"), whose model
    stands at its first phase's scale (the Archmother at 0.8). One skin each: the team's own model."""
    out = []
    for kind in ('shrine', 'patron'):
        for team in (0, 1):
            placed = [v for v in entities if spawn_kind(v) == kind and TEAMS.get(str(v.get('teamnumber'))) == team]
            if not placed:
                raise ValueError(f'the map places no {kind} of team {team}')
            v = placed[0]
            scale = float(np.asarray(v.get('scales', (1.0, 1.0, 1.0)), float)[0])
            if kind == 'shrine':
                building = npc.get('destroyable_building', {})
                path = v.get('model') or building[('m_sAmberModelName', 'm_sSapphModelName')[team]]
            else:
                boss = npc[v.get('subclass_name') or 'npc_boss_tier3']
                path, scale = boss['m_sModelName'], scale * float(boss.get('m_flPhase1BossScale', 1.0))
            out.append({'name': f'{kind}_{team}', 'path': path, 'scale': scale, 'lift': 0.0, 'material': None,
                        'skins': {'0': None}})
    return out


def readable(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """An sRGB colour, lightened towards white just enough to reach LEAST_LUMINANCE."""
    def luminance(c):
        lin = (np.asarray(c, float) / 255) ** 2.2
        return float(lin @ np.array([0.2126, 0.7152, 0.0722]))

    for t in np.linspace(0, 1, 101):
        mixed = tuple(int(round(c + (255 - c) * t)) for c in rgb)
        if luminance(mixed) >= LEAST_LUMINANCE:
            return mixed
    return (255, 255, 255)


def powerup_kinds(pak: Vpk, citadel: Path) -> list[dict]:
    """The bridge power-ups' kinds, as their spawner picks them: each kind's name, English name, colour for the map,
    what it gives and its minimap icon (viewBox size and paths: d, opacity, even-odd fill)."""
    misc = kv3(blocks(pak.read('scripts/misc.vdata_c'))['DATA'])
    loc = citadel / 'resource' / 'localization' / 'citadel_main' / 'citadel_main_english.txt'
    english = dict(re.findall(r'"(\w+_powerup_pickup)"\s+"([^"]*)"', loc.read_text('utf-8', 'replace'))) if loc.exists() else {}
    out = []
    for pickup in misc['citadel_item_powerup_spawner']['m_mapPickupChances']:
        kind = pickup.removesuffix('_powerup_pickup')
        e = misc[pickup]
        values = [v['m_eModifierValue'].removeprefix('MODIFIER_VALUE_') for v in e.get('m_sModifer', {}).get('m_vecModifierValues', [])]
        gives = [GIVES.get(v, v.lower().replace('_', ' ')) for v in values]
        data = blocks(pak.read(f'panorama/images/minimap/powerup_{MINIMAP_ICONS[kind]}.vsvg_c'))['DATA']
        svg = data[data.index(b'<svg'):].decode('utf-8')  # a compiled SVG is the SVG after a short header
        box = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()][2:]
        paths = []
        for el in re.findall(r'<path\b[^>]*>', svg):
            opacity = re.search(r'fill-opacity="([\d.]+)"', el)
            paths.append((re.search(r'\bd="([^"]+)"', el).group(1), float(opacity.group(1)) if opacity else 1.0,
                          'fill-rule="evenodd"' in el))
        out.append({'kind': kind, 'name': english.get(pickup, kind.title()), 'colour': readable(tuple(int(c) for c in e['m_Color'][:3])),
                    'gives': ', '.join(gives[:-1]) + (' and ' if len(gives) > 1 else '') + gives[-1] if gives else '',
                    'box': box, 'paths': paths})
    return out


def write_powerup_icons(kinds: list[dict]):
    """src/lib/powerupIcons.ts: the map's look of each bridge power-up kind."""
    lines = [
        '// Generated by scripts/map_objects.py from the game\'s files (its power-up kinds, colours, English names and',
        '// minimap icons): do not edit by hand.',
        "import type { PowerupKind } from '../api/types';",
        '',
        '/** How the map shows a kind of bridge power-up. */',
        'export interface PowerupLook {',
        '  /** The game\'s English name for it. */',
        '  name: string;',
        '  /** What it gives, in a few words. */',
        '  gives: string;',
        "  /** Its colour: the game's (it tints the crystal and icons with it), lightened where too dark for the map. */",
        '  color: string;',
        '  /** Its minimap icon: the viewBox\'s width and height, and its paths (the ring\'s segments half see-through). */',
        '  box: [number, number];',
        '  paths: { d: string; opacity: number; evenOdd: boolean }[];',
        '}',
        '',
        '/** The kinds the game drops on the bridges, in its order. */',
        'export const POWERUP_LOOKS: Record<PowerupKind, PowerupLook> = {',
    ]
    for k in kinds:
        lines.append(f'  {k["kind"]}: {{')
        lines.append(f"    name: '{k['name']}',")
        lines.append(f"    gives: '{k['gives']}',")
        lines.append("    color: '#{:02x}{:02x}{:02x}',".format(*k['colour']))
        lines.append(f'    box: [{k["box"][0]:g}, {k["box"][1]:g}],')
        lines.append('    paths: [')
        for d, opacity, even_odd in k['paths']:
            lines.append(f"      {{ d: '{d}', opacity: {opacity:g}, evenOdd: {'true' if even_odd else 'false'} }},")
        lines.append('    ],')
        lines.append('  },')
    lines += ['};', '']
    ICONS_OUT.write_text('\n'.join(lines), encoding='utf-8', newline='\n')


def team_group(model: Model, group: str | None, team: str) -> str | None:
    """The material group a team's skin uses: the one named for the team, else (the walker has none) the
    Archmother's takes the "friendly" skin, the Hidden King's the default."""
    if group is None or group in model.groups:
        return group
    return 'friendly' if team == '1' and 'friendly' in model.groups else None


# The map's entities that place one of the models, by class.
SPAWN_KINDS = {'npc_boss_tier2': 'walker', 'npc_barrack_boss': 'base_guardian', 'destroyable_building': 'shrine',
               'npc_boss_tier3': 'patron', 'citadel_item_powerup_spawner': 'powerup'}


def map_entities(game: Vpk, map_name: str) -> list[dict]:
    """The key values of every entity the map places."""
    out = []
    for lump in sorted(k for k in game.entries if k.startswith(f'maps/{map_name}/entities/') and k.endswith('.vents_c')):
        for e in kv3(blocks(game.read(lump))['DATA']).get('m_entityKeyValues', []):
            out.append((e.get('keyValues3Data') or {}).get('values') or {})
    return out


def spawn_kind(v: dict) -> str | None:
    """What a map entity (its key values) places: guardian, walker, base_guardian, shrine, patron, powerup or None."""
    if v.get('classname') == 'info_super_trooper_spawn':
        # A lane's guardian spawns here; the other super-trooper spawns are reinforcements.
        return 'guardian' if v.get('BossName') and not v.get('ReinforcementsOnly') else None
    return SPAWN_KINDS.get(v.get('classname'))


def spawns(entities: list[dict]) -> list[tuple[str, int, float, float, float, float]]:
    """(kind, team, x, y, z, yaw) of every guardian, walker, base guardian, shrine, patron and bridge power-up the map
    places, from its entities (see map_entities)."""
    out = []
    for v in entities:
        kind = spawn_kind(v)
        if not kind:
            continue
        x, y, z = (float(a) for a in v['origin'])
        yaw = float(v.get('angles', (0, 0, 0))[1])
        out.append((kind, TEAMS.get(str(v.get('teamnumber')), 255), x, y, z, yaw))
    return sorted(out)


def write_shrine_icon(pak: Vpk):
    """public/icons/objectives/shrine.webp: the glowing top of the game's picture of a shrine, a square ICON_SIZE wide
    (as scripts/wiki_icons.py makes the other objectives' icons), for the map's markers."""
    im = picture(pak, SHRINE_PICTURE, largest=1024).convert('RGBA')
    left, top, right, bottom = SHRINE_CROP
    im = im.crop((round(left * im.width), round(top * im.height), round(right * im.width), round(bottom * im.height)))
    im.thumbnail((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    square = Image.new('RGBA', (ICON_SIZE, ICON_SIZE))
    square.alpha_composite(im, ((ICON_SIZE - im.width) // 2, (ICON_SIZE - im.height) // 2))
    SHRINE_ICON_OUT.parent.mkdir(parents=True, exist_ok=True)
    square.save(SHRINE_ICON_OUT, 'WEBP', quality=85, method=6)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--game', type=Path, help="Deadlock's install folder (found through Steam if left out)")
    ap.add_argument('--map', default='dl_midtown')
    args = ap.parse_args()
    game_dir = args.game or find_game()
    if not game_dir:
        sys.exit('Deadlock not found: pass --game "<Steam library>/steamapps/common/Deadlock"')
    citadel = Path(game_dir) / 'game' / 'citadel'
    t0 = time.time()
    pak = Vpk(citadel / 'pak01_dir.vpk')
    game = Vpk(citadel / 'maps' / f'{args.map}.vpk')
    looks: dict[str, Look] = {}

    def look(path: str) -> Look:
        if path not in looks:
            looks[path] = Look(pak, path)
        return looks[path]

    kinds = powerup_kinds(pak, citadel)
    write_powerup_icons(kinds)
    write_shrine_icon(pak)
    print(f'{time.time() - t0:6.1f}s  power-up kinds {[k["name"] for k in kinds]}; wrote {ICONS_OUT.relative_to(ROOT)} '
          f'and {SHRINE_ICON_OUT.relative_to(ROOT)}', flush=True)

    entities = map_entities(game, args.map)
    out = bytearray(b'NOBJ')
    models = objective_models(pak, entities)
    out += struct.pack('<II', 1, len(models))
    for spec in models:
        model = Model(pak, spec['path'])
        skins = {}
        for skin, group in spec['skins'].items():
            materials = [spec['material']] * len(model.materials) if spec['material'] else model.skin(team_group(model, group, skin))
            colour, glow, shown = face_colours(model, [look(m) for m in materials])
            if spec.get('glow'):
                colour, glow = colour * (1 - spec['glow']) + colour / max(colour.max(), 1e-6) * spec['glow'], np.maximum(glow, spec['glow'])
            skins[skin] = (colour, glow, shown)
        if spec['name'] == 'powerup':
            # The game tints the crystal with its kind's colour: a skin for each kind, named for it.
            base_colour, base_glow, shown = skins['0']
            for k in kinds:
                tint = (np.asarray(k['colour'], float) / 255) ** 2.2
                skins[k['kind']] = (np.broadcast_to(tint, base_colour.shape).copy(), base_glow, shown)
        shown = next(iter(skins.values()))[2]
        T = model.T[shown]
        flat = [a[shown] for c, g, _ in skins.values() for a in (c, g)]
        V, F, merged = simplified(model.P, T, flat, TARGET[spec['name']])
        V = V + np.array([0, 0, spec['lift'] / spec['scale']])  # lifted in model units: the scale applies after
        lo, hi = V.min(0), V.max(0)
        name = spec['name'].encode()
        out += struct.pack('<B', len(name)) + name
        out += struct.pack('<fII', spec['scale'], len(V), len(F))
        out += struct.pack('<6f', *lo, *hi)
        out += struct.pack('<I', len(skins))
        q = np.clip(np.round((V - lo) / np.maximum(hi - lo, 1e-6) * 65535), 0, 65535).astype('<u2')
        out += q.tobytes()
        if len(V) > 65535:
            raise ValueError(f'{spec["name"]}: too many vertices for u16 indices')
        out += F.astype('<u2').tobytes()
        for i, skin in enumerate(skins):
            colour, glow = merged[2 * i], merged[2 * i + 1]
            srgb = np.clip(np.clip(colour, 0, 1) ** (1 / 2.2) * 255 + 0.5, 0, 255).astype('u1')
            label = skin.encode()
            out += struct.pack('<B', len(label)) + label
            out += srgb.tobytes() + np.clip(np.round(glow * 255), 0, 255).astype('u1').tobytes()
        print(f'{time.time() - t0:6.1f}s  {spec["name"]}: {spec["path"]} ({len(model.T):,} triangles) -> '
              f'{len(F):,} triangles, {len(V):,} vertices; skins {list(spec["skins"].values())}', flush=True)
    places = spawns(entities)
    out += struct.pack('<I', len(places))
    for kind, team, x, y, z, yaw in places:
        label = kind.encode()
        out += struct.pack('<B', len(label)) + label + struct.pack('<B4f', team, x, y, z, yaw)
    counts = {k: sum(1 for p in places if p[0] == k) for k in ('guardian', 'walker', 'base_guardian', 'shrine', 'patron', 'powerup')}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(gzip.compress(bytes(out), 9, mtime=0))
    print(f'{time.time() - t0:6.1f}s  spawns {counts}; wrote {OUT.relative_to(ROOT)}: '
          f'{OUT.stat().st_size / 1e6:.2f} MB ({len(out) / 1e6:.2f} MB unpacked)')


if __name__ == '__main__':
    main()
