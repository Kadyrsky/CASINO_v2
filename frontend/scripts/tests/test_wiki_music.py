"""The music import (scripts/wiki_music.py): the loop edit, the silence trim, the gapless header it reads the exact
lengths from, and the committed music matching its manifest.

    python -m pytest scripts/tests        (from frontend/; standard library and pytest)
"""
import array
import json
from pathlib import Path

import pytest

import wiki_music as wm

MUSIC = Path(__file__).resolve().parents[2] / 'public' / 'music'


def samples(*values: int) -> array.array:
    return array.array('h', values)


# ---------------------------------------------------------------- the loop edit

def test_loop_edit_cuts_and_adds_the_part_after_the_cut_onto_the_start():
    rate = 10  # ten samples a second, so 1.0 s = 10 samples
    track = samples(*range(1, 31))  # 3 s, mono
    out = wm.loop_edit(track, 1, rate, loop_at=2.0, carry=0.5)
    assert len(out) == 20  # cut at exactly 2 s
    # 0.0-0.5 s: the start plus 2.0-2.5 s, added rather than replacing it
    assert list(out[:5]) == [1 + 21, 2 + 22, 3 + 23, 4 + 24, 5 + 25]
    assert list(out[5:]) == list(range(6, 21))  # the rest untouched


def test_loop_edit_keeps_stereo_frames_together():
    rate = 4
    left, right = range(0, 100, 10), range(1000, 1100, 10)
    track = samples(*(v for pair in zip(left, right) for v in pair))  # 10 frames = 2.5 s
    out = wm.loop_edit(track, 2, rate, loop_at=1.5, carry=0.5)
    assert len(out) == 12  # 6 frames
    assert list(out[:4]) == [0 + 60, 1000 + 1060, 10 + 70, 1010 + 1070]  # frames 6 and 7 onto frames 0 and 1
    assert list(out[4:]) == list(track[4:12])


def test_loop_edit_clips_instead_of_wrapping_around():
    out = wm.loop_edit(samples(30000, -30000, 30000, -30000), 1, 1, loop_at=2.0, carry=2.0)
    assert list(out) == [32767, -32768]


def test_loop_edit_refuses_a_track_too_short_for_the_cut():
    with pytest.raises(ValueError):
        wm.loop_edit(samples(*range(10)), 1, 10, loop_at=0.8, carry=0.5)


def test_paying_the_price_is_cut_at_49_s_with_0_7_s_carried_over():
    spec = wm.TRACKS['price']
    assert isinstance(spec, wm.Source)
    assert (spec.file, spec.loop_at, spec.carry) == ('Cadence Song.wav', 49.0, 0.7)


# ---------------------------------------------------------------- the silence trim

def test_trim_silence_drops_quiet_ends_in_whole_frames():
    quiet, loud = 5, 2000  # -76 dBFS and -24 dBFS
    track = samples(quiet, -quiet, 0, 0, loud, 0, -loud, quiet, 0, quiet, 0, 0)  # stereo: 6 frames
    out = wm.trim_silence(track, 2)
    assert list(out) == [loud, 0, -loud, quiet]


def test_trim_silence_of_silence_is_empty():
    assert len(wm.trim_silence(samples(0, 1, -2, 0), 1)) == 0


# ---------------------------------------------------------------- the gapless header

def test_gapless_reads_the_exact_length_and_the_encoder_delay():
    # Made by the import: Paying the Price, mono, 44.1 kHz, exactly 49 s.
    assert wm.gapless((MUSIC / 'price.mp3').read_bytes()) == (49 * 44100, 576 + wm.DECODER_DELAY, 44100)
    # The wiki's hideout loop: 28 bars at 155 bpm.
    count, _, rate = wm.gapless((MUSIC / 'hideout-base.mp3').read_bytes())
    assert count == 1911949 and abs(count / rate - 28 * 4 * 60 / 155) < 1 / rate


def test_gapless_needs_a_lame_header():
    assert wm.gapless(b'\x00' * 400) is None
    frame = bytearray(b'\xff\xfb\x90\x64' + bytes(400))  # MPEG-1 Layer III, 128 kbps, 44.1 kHz, no Xing header
    assert wm.gapless(bytes(frame)) is None
    assert wm.mp3_seconds(bytes(frame)) == round(1152 / 44100, 2)


def test_describe_falls_back_to_counting_frames():
    frame = b'\xff\xfb\x90\x64' + bytes(417 - 4)  # one 417-byte frame
    assert wm.describe(frame * 10) == {'duration': round(10 * 1152 / 44100, 2), 'bytes': 4170}


# ---------------------------------------------------------------- the committed music

def test_every_track_is_committed_and_listed_with_its_exact_length():
    manifest = json.loads((MUSIC / 'manifest.json').read_text('utf-8'))
    assert list(manifest) == [slug for slug in wm.FILES if slug in manifest]
    assert set(wm.TRACKS) <= set(manifest)  # every music pack's track
    for slug, info in manifest.items():
        data = (MUSIC / f'{slug}.mp3').read_bytes()
        assert info['bytes'] == len(data), slug
        assert {k: info[k] for k in ('duration', 'lead', 'bytes') if k in info} == wm.describe(data), slug
        assert -40 < info['lufs'] < 0, slug


def test_no_stray_mp3s_in_the_music_folder():
    assert {p.stem for p in MUSIC.glob('*.mp3')} == set(wm.FILES)
