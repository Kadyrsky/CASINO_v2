"""Downloads Deadlock's music and stingers from the Deadlock Wiki (https://deadlock.wiki/Music) for the site's music
packs and the Deadlock sound pack, and makes the tracks that need it ready to loop.

    python frontend/scripts/wiki_music.py              (for `vp dev`; standard library, plus ffmpeg for some tracks)
    python frontend/scripts/wiki_music.py --out DIR    (the core's Docker build uses this, with --require)

Writes public/music/<slug>.mp3 and public/music/manifest.json:

    {slug: {"duration": seconds, "lead": seconds, "bytes": n, "lufs": x}}

`duration` is the exact length of the audio, without the silence MP3 encoders add at both ends, and `lead` is where
the audio starts in a decoder that leaves that silence in (Chrome, Firefox and WebKit take it out, going by the
LAME header): the player loops exactly the audio, so the loops have no gap. The frontend (src/lib/musicCatalog.ts)
only offers what the manifest lists.

The files are committed in public/music (the repository is private), so this is only needed to add or refresh
tracks. Files already in the folder are kept: the script picks MP3s up even without their manifest and only fetches
what's missing. To redo a track, delete its MP3 and run the script again.

Most tracks are the wiki's MP3s as they are. A few need ffmpeg (the Docker build installs it):
  - Paying the Price is a WAV: it is cut at 49 s, and the 0.7 s after the cut are mixed onto its start (added, not
    replacing it), so the track loops without a seam;
  - the matchmaking wait loop is Ogg Vorbis, which Safari can't play: it becomes an MP3, without the silence at its
    ends, so the loop doesn't pause.
The MP3s made here are labelled LAME3.100 (the encoder ffmpeg runs) in their gapless header: WebKit only trims MP3s
labelled LAME, and leaves a gap in the loop otherwise.

The tracks differ in loudness by up to 25 dB (the hotel's record is mixed far quieter than the title theme). If ffmpeg
is installed, each file's integrated loudness (EBU R128, in LUFS) goes into the manifest and the player evens them
out, so in the taste test no pack wins just by being louder.

The audio is Valve's, as hosted by the wiki: if the repository is ever made public, take the files out of git first.
"""
import argparse
import array
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

API = 'https://deadlock.wiki/api.php'
UA = {'User-Agent': 'naebka-music/1.0 (student project; one-off music import)'}
ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Source:
    """A wiki file that ffmpeg turns into the site's MP3."""
    file: str
    #: Cut the track here (seconds) and mix the `carry` seconds after the cut onto its start: a seamless loop.
    loop_at: float | None = None
    carry: float = 0.0
    #: Drop the near-silence (below -60 dBFS) at both ends, so the loop doesn't pause.
    trim_silence: bool = False
    #: LAME's VBR quality, 0 (best) to 9 (smallest).
    quality: int = 2


# slug -> wiki file. Keep the slugs in sync with src/lib/musicPacks.ts.
# The music packs' tracks: every one of them is needed (--require).
TRACKS: dict[str, str | Source] = {
    'title': 'Music title 155bpm.mp3',
    'hideout-base': 'Music hideout play base lp 155bpm.mp3',
    'hideout-low': 'Music hideout play low lp 155bpm.mp3',
    'hideout-high': 'Music hideout play high lp 155bpm.mp3',
    'search-wait': Source('Music search wait temp.ogg', trim_silence=True, quality=6),
    'connecting-old': 'Music match intro connecting 60bpm old.mp3',
    'hotel': 'Hotel music.mp3',
    'hotel-far': 'Hotel music far.mp3',
    'curio': 'Curio music.mp3',
    'curio-alt': 'Curio music 02.mp3',
    'winter-menu': 'Music menu winter24 lp.mp3',
    'winter-shop': 'Music curio christmas.mp3',
    'winter-secret': 'Music curio secret christmas.mp3',
    'waltz': 'Waltz.mp3',
    'choir': 'Music choir 01.mp3',
    'teleporter': 'Music teleporter 01.mp3',
    'teleporter-comp': 'Teleporter music comp.mp3',
    'teleporter-melody': 'Teleporter music melody.mp3',
    'price': Source('Cadence Song.wav', loop_at=49.0, carry=0.7),
}
# Stingers (the Deadlock sound pack): a missing one is played by its synthesized stand-in.
STINGERS: dict[str, str | Source] = {
    **{f'ks-{n:02d}': f'Music stinger ks {n:02d}.mp3' for n in range(1, 11)},
    'first-blood': 'Music stinger first blood.mp3',
    'urn-arrived': 'Music idol announce.mp3',
    'urn-delivered': 'Music idol return team.mp3',
    'rift-announce': 'Music koth announce.mp3',
    'rift-secured': 'Music koth win.mp3',
    'victory': 'Music stinger game over win.mp3',
    'defeat': 'Music stinger game over lose.mp3',
    'rejuv-won': 'Music stinger rejuv won.mp3',
    'rejuv-lost': 'Music stinger rejuv lost.mp3',
    'guardian-down': 'Music stinger t1 killed.mp3',
    # The title screen's short swell into the hideout: what picking a theme plays.
    'transition': 'Music hideout build 155bpm.mp3',
}
FILES = {**TRACKS, **STINGERS}

HOW_TO_FIX = """wiki_music: how to get the music:
  - try again: a network hiccup is the usual cause (the next build retries, a failed step isn't cached);
  - or restore frontend/public/music from git (it is committed), or run `python frontend/scripts/wiki_music.py` on
    a machine that can open https://deadlock.wiki (with ffmpeg installed), then build again;
  - or build without fetching music: NAEBKA_MUSIC=skip docker compose up --build"""

# MPEG audio frame tables (Layer III only), for the duration.
BITRATES = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000]}
#: An MP3 decoder's own delay, on top of the encoder's (which the LAME header gives).
DECODER_DELAY = 529


def wiki_file(spec: str | Source) -> str:
    return spec.file if isinstance(spec, Source) else spec


def first_frame(data: bytes) -> int:
    """Where the MPEG audio starts: after an ID3v2 tag, if there is one."""
    if data[:3] == b'ID3':
        return 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    return 0


def frame_header(data: bytes, pos: int) -> tuple[int, int, int] | None:
    """(sample rate, samples per frame, frame length in bytes) of a Layer III frame header at pos, or None."""
    if pos + 4 > len(data) or data[pos] != 0xFF or (data[pos + 1] & 0xE0) != 0xE0:
        return None
    b1, b2 = data[pos + 1], data[pos + 2]
    version = {0: 25, 2: 2, 3: 1}.get((b1 >> 3) & 3)
    layer = (b1 >> 1) & 3
    bitrate_index, rate_index = b2 >> 4, (b2 >> 2) & 3
    if version is None or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    bitrate = BITRATES[1 if version == 1 else 2][bitrate_index] * 1000
    rate = RATES[version][rate_index]
    length = (144 if version == 1 else 72) * bitrate // rate + ((b2 >> 1) & 1)
    return rate, 1152 if version == 1 else 576, length


def mp3_seconds(data: bytes) -> float | None:
    """Duration by walking the MPEG frames (works for constant and variable bit rates)."""
    pos = first_frame(data)
    samples, rate = 0, 0
    while pos + 4 <= len(data):
        header = frame_header(data, pos)
        if header is None:
            pos += 1
            continue
        rate, per_frame, length = header
        samples += per_frame
        pos += length
    return round(samples / rate, 2) if rate else None


def gapless(data: bytes) -> tuple[int, int, int] | None:
    """(audio samples, samples before the audio in an untrimmed decode, sample rate) from the Xing/Info header's
    LAME extension, which records how much silence the encoder added at each end; None without one."""
    pos = first_frame(data)
    header = frame_header(data, pos)
    if header is None:
        return None
    rate, per_frame, _ = header
    for tag in (b'Xing', b'Info'):
        i = data.find(tag, pos, pos + 64)
        if i < 0:
            continue
        flags = int.from_bytes(data[i + 4:i + 8], 'big')
        j = i + 8
        if not flags & 1:
            return None
        frames = int.from_bytes(data[j:j + 4], 'big')
        j += 4 + (4 if flags & 2 else 0) + (100 if flags & 4 else 0) + (4 if flags & 8 else 0)
        if data[j:j + 4] not in (b'LAME', b'Lavc', b'Lavf'):
            return None
        d = data[j + 21:j + 24]
        delay, padding = (d[0] << 4) | (d[1] >> 4), ((d[1] & 0x0F) << 8) | d[2]
        return frames * per_frame - delay - padding, delay + DECODER_DELAY, rate
    return None


def describe(data: bytes) -> dict | None:
    """The manifest's numbers for an MP3: exact duration and lead (seconds), and size; None if it isn't an MP3."""
    info = gapless(data)
    if info:
        samples, lead, rate = info
        return {'duration': round(samples / rate, 6), 'lead': round(lead / rate, 6), 'bytes': len(data)}
    seconds = mp3_seconds(data)
    return {'duration': seconds, 'bytes': len(data)} if seconds else None


# ---- Editing (on 16-bit samples, interleaved) ----

def loop_edit(samples: array.array, channels: int, rate: int, loop_at: float, carry: float) -> array.array:
    """The track cut at `loop_at` seconds, with the `carry` seconds after the cut added onto its start: played in a
    loop, the start then carries on as the cut-off part would have (a reverb tail, a held note), without a seam."""
    cut = round(loop_at * rate) * channels
    extra = round(carry * rate) * channels
    if len(samples) < cut + extra:
        raise ValueError(f'the track is {len(samples) / channels / rate:.2f} s, shorter than {loop_at + carry} s')
    out = samples[:cut]
    for i in range(extra):
        out[i] = max(-32768, min(32767, out[i] + samples[cut + i]))
    return out


def trim_silence(samples: array.array, channels: int, threshold_db: float = -60.0) -> array.array:
    """Without the samples quieter than `threshold_db` (dBFS) at the start and the end (whole frames)."""
    limit = 32768 * 10 ** (threshold_db / 20)
    first = next((i for i, s in enumerate(samples) if abs(s) > limit), None)
    if first is None:
        return samples[:0]
    last = next(i for i in range(len(samples) - 1, -1, -1) if abs(samples[i]) > limit)
    return samples[first // channels * channels:(last // channels + 1) * channels]


# ---- ffmpeg ----

def ffmpeg_tools() -> tuple[str, str] | None:
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    return (ffmpeg, ffprobe) if ffmpeg and ffprobe else None


def decode(path: Path) -> tuple[array.array, int, int]:
    """16-bit samples (interleaved), channels and sample rate of an audio file, by ffmpeg."""
    ffmpeg, ffprobe = ffmpeg_tools()  # type: ignore[misc]
    probe = json.loads(subprocess.run([ffprobe, '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                                       'stream=channels,sample_rate', '-of', 'json', str(path)],
                                      capture_output=True, text=True, check=True).stdout)['streams'][0]
    raw = subprocess.run([ffmpeg, '-v', 'error', '-i', str(path), '-f', 's16le', '-acodec', 'pcm_s16le', '-'],
                         capture_output=True, check=True).stdout
    samples = array.array('h')
    samples.frombytes(raw)
    if sys.byteorder == 'big':
        samples.byteswap()
    return samples, int(probe['channels']), int(probe['sample_rate'])


def encode(samples: array.array, channels: int, rate: int, quality: int, dest: Path) -> None:
    """An MP3 with a gapless header (labelled LAME3.100, so WebKit trims it too) and no ID3 tag."""
    ffmpeg, _ = ffmpeg_tools()  # type: ignore[misc]
    if sys.byteorder == 'big':
        samples = array.array('h', samples)
        samples.byteswap()
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-f', 's16le', '-ar', str(rate), '-ac', str(channels), '-i', '-',
                    '-c:a', 'libmp3lame', '-q:a', str(quality), '-id3v2_version', '0', '-map_metadata', '-1',
                    '-metadata:s:a:0', 'encoder=LAME3.100', str(dest)], input=samples.tobytes(), check=True)


def make(spec: Source, source: Path, dest: Path) -> None:
    """The site's MP3 of a wiki file that needs editing or converting."""
    samples, channels, rate = decode(source)
    if spec.trim_silence:
        samples = trim_silence(samples, channels)
    if spec.loop_at is not None:
        samples = loop_edit(samples, channels, rate, spec.loop_at, spec.carry)
    encode(samples, channels, rate, spec.quality, dest)
    info = gapless(dest.read_bytes())
    if not info or info[0] != len(samples) // channels:
        raise RuntimeError(f'{dest.name}: the encoder did not record the exact length')


def loudness(path: Path) -> float | None:
    """Integrated loudness (EBU R128, LUFS) as measured by ffmpeg, or None without ffmpeg."""
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return None
    try:
        r = subprocess.run([ffmpeg, '-hide_banner', '-nostats', '-i', str(path), '-af', 'ebur128=framelog=quiet',
                            '-f', 'null', '-'], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = re.findall(r'I:\s+(-?\d+(?:\.\d+)?) LUFS', r.stderr)
    return float(found[-1]) if found else None


# ---- The wiki ----

def get(url: str, timeout: int) -> bytes:
    """GET with three tries, waiting a little longer each time, for the errors that tend to go away by themselves."""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (408, 425, 429, 500, 502, 503, 504) or attempt == 2:
                raise
        except OSError:
            if attempt == 2:
                raise
        time.sleep(2 * (attempt + 1))
    raise AssertionError('unreachable')


def file_urls(titles):
    urls = {}
    titles = list(titles)
    for i in range(0, len(titles), 40):
        q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'formatversion': '2', 'prop': 'imageinfo',
                                    'iiprop': 'url', 'titles': '|'.join('File:' + t for t in titles[i:i + 40])})
        pages = json.loads(get(f'{API}?{q}', 60))['query']['pages']
        # The API reports titles with underscores turned into spaces and the first letter upper-cased.
        asked = {t.replace('_', ' ').lower(): t for t in titles[i:i + 40]}
        for p in pages:
            if p.get('imageinfo'):
                title = p['title'].removeprefix('File:')
                urls[asked.get(title.lower(), title)] = p['imageinfo'][0]['url']
    return urls


def fetch(missing: list[str], out: Path, manifest: dict) -> None:
    """Downloads (and makes) the missing files, adding them to the manifest."""
    try:
        urls = file_urls(wiki_file(FILES[slug]) for slug in missing)
    except (OSError, ValueError, KeyError) as e:
        print(f'wiki_music: cannot reach https://deadlock.wiki ({e})', file=sys.stderr)
        return
    for slug in missing:
        spec = FILES[slug]
        title = wiki_file(spec)
        url = urls.get(title)
        if not url:
            print(f'wiki_music: {title} is no longer on the wiki', file=sys.stderr)
            continue
        if isinstance(spec, Source) and not ffmpeg_tools():
            print(f'wiki_music: {slug} ({title}) needs ffmpeg to make, skipped', file=sys.stderr)
            continue
        try:
            data = get(url, 120)
        except OSError as e:
            print(f'wiki_music: {title}: {e}', file=sys.stderr)
            continue
        dest = out / f'{slug}.mp3'
        if isinstance(spec, Source):
            with tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / ('source' + Path(title).suffix)
                source.write_bytes(data)
                try:
                    make(spec, source, dest)
                except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as e:
                    print(f'wiki_music: {slug}: {e}', file=sys.stderr)
                    dest.unlink(missing_ok=True)
                    continue
            data = dest.read_bytes()
        info = describe(data)
        if not info:
            print(f'wiki_music: {title} is not an MP3, skipped', file=sys.stderr)
            continue
        if not isinstance(spec, Source):
            dest.write_bytes(data)
        manifest[slug] = info
        time.sleep(0.2)  # be gentle with the wiki


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--out', type=Path, default=ROOT / 'public' / 'music')
    parser.add_argument('--require', action='store_true',
                        help='exit with an error (and what to do) unless every music track is there')
    parser.add_argument('--offline', action='store_true', help="don't contact the wiki; only list the files already there")
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    manifest_path = out / 'manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.exists() else {}
    except ValueError:
        manifest = {}
    # MP3s copied in by hand (without their manifest), changed, or listed before the manifest had exact lengths.
    for slug in FILES:
        dest = out / f'{slug}.mp3'
        old = manifest.get(slug, {})
        if dest.exists() and ('lead' not in old or old.get('bytes') != dest.stat().st_size):
            info = describe(dest.read_bytes())
            if info:
                kept = {'lufs': old['lufs']} if 'lufs' in old and old.get('bytes') == info['bytes'] else {}
                manifest[slug] = {**info, **kept}

    missing = [slug for slug in FILES if slug not in manifest or not (out / f'{slug}.mp3').exists()]
    if missing and not args.offline:
        fetch(missing, out, manifest)

    manifest = {k: manifest[k] for k in FILES if k in manifest and (out / f'{k}.mp3').exists()}
    for slug, info in manifest.items():
        if 'lufs' not in info:
            lufs = loudness(out / f'{slug}.mp3')
            if lufs is not None:
                info['lufs'] = lufs
    manifest_path.write_text(json.dumps(manifest, indent=1) + '\n', encoding='utf-8', newline='\n')
    total = sum(m['bytes'] for m in manifest.values()) / 1e6
    measured = sum('lufs' in m for m in manifest.values())
    print(f'wiki_music: {len(manifest)}/{len(FILES)} files in {out} ({total:.1f} MB), loudness measured for {measured}'
          + ('' if measured or not manifest else ' (install ffmpeg to measure it)'))

    tracks_missing = [slug for slug in TRACKS if slug not in manifest]
    stingers_missing = [slug for slug in STINGERS if slug not in manifest]
    if stingers_missing:
        print(f'wiki_music: {len(stingers_missing)} stingers missing (their synthesized sounds play instead): '
              + ', '.join(stingers_missing), file=sys.stderr)
    if tracks_missing:
        print(f'wiki_music: {len(tracks_missing)} of {len(TRACKS)} music tracks missing: ' + ', '.join(tracks_missing),
              file=sys.stderr)
        if args.require:
            print(HOW_TO_FIX, file=sys.stderr)
            sys.exit(2)


if __name__ == '__main__':
    main()
