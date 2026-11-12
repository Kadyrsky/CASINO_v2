"""Downloads Deadlock's music and stingers from the Deadlock Wiki (https://deadlock.wiki/Music) for the site's
music player and the Deadlock sound pack.

    python frontend/scripts/wiki_music.py              (standard library only; for `vp dev`)
    python frontend/scripts/wiki_music.py --out DIR    (the core's Docker build uses this, with --require)

Writes public/music/<slug>.mp3 and public/music/manifest.json ({slug: {"duration": seconds, "bytes": n, "lufs": x}}).
The frontend (src/lib/musicCatalog.ts) only offers what the manifest lists.

The files are committed in public/music (the repository is private), so this is only needed to add or refresh tracks.
Files already in the folder are kept: the script picks MP3s up even without their manifest and downloads what's missing.

The tracks differ in loudness by up to 25 dB (the hotel's record is mixed far quieter than the title theme). If ffmpeg
is installed (the Docker build installs it), each file's integrated loudness (EBU R128, in LUFS) goes into the
manifest and the player evens them out, so in the taste test no station wins just by being louder.

The audio is Valve's, as hosted by the wiki: if the repository is ever made public, take the files out of git first.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://deadlock.wiki/api.php'
UA = {'User-Agent': 'naebka-music/1.0 (student project; one-off music import)'}
ROOT = Path(__file__).resolve().parent.parent

# slug -> wiki file. Keep the slugs in sync with src/lib/musicCatalog.ts.
# Background music (the stations): the music experiment needs all of them.
TRACKS = {
    'hotel': 'Hotel music.mp3',
    'curio': 'Curio music.mp3',
    'waltz': 'Waltz.mp3',
    'rem': 'Music hideout rem 70bpm.mp3',
    'title': 'Music title 155bpm.mp3',
    'hideout': 'Music hideout play base lp 155bpm.mp3',
    'postgame': 'Music postgame 155bpm.mp3',
    'draft': 'Music brawl draft 95bpm.mp3',
    'menu-old': 'Music menu lp.mp3',
    'choir': 'Music choir 01.mp3',
    'vault': 'Vault music.mp3',
    'rift': 'Music koth capture 160bpm.mp3',
    'urn': 'Music idol carry lp 141bpm.mp3',
    'core': 'Music core exposed lp.mp3',
}
# Stingers (the Deadlock sound pack): a missing one is played by its synthesized stand-in.
STINGERS = {
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
    'king-intro': 'Music match intro king 160bpm.mp3',
    'mother-intro': 'Music match intro mother 160bpm.mp3',
}
FILES = {**TRACKS, **STINGERS}

HOW_TO_FIX = """wiki_music: how to get the music:
  - try again: a network hiccup is the usual cause (the next build retries, a failed step isn't cached);
  - or restore frontend/public/music from git (it is committed), or run `python frontend/scripts/wiki_music.py` on
    a machine that can open https://deadlock.wiki, then build again;
  - or build without fetching music: NAEBKA_MUSIC=skip docker compose up --build"""

# MPEG audio frame tables (Layer III only), for the duration.
BITRATES = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000]}


def mp3_seconds(data: bytes) -> float | None:
    """Duration by walking the MPEG frames (works for constant and variable bit rates)."""
    pos = 0
    if data[:3] == b'ID3':
        size = (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F)
        pos = 10 + size
    samples, rate = 0, 0
    while pos + 4 <= len(data):
        b1, b2 = data[pos + 1], data[pos + 2]
        if data[pos] != 0xFF or (b1 & 0xE0) != 0xE0:
            pos += 1
            continue
        version = {0: 25, 2: 2, 3: 1}.get((b1 >> 3) & 3)
        layer = (b1 >> 1) & 3
        bitrate_index, rate_index = b2 >> 4, (b2 >> 2) & 3
        if version is None or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
            pos += 1
            continue
        bitrate = BITRATES[1 if version == 1 else 2][bitrate_index] * 1000
        rate = RATES[version][rate_index]
        per_frame = 1152 if version == 1 else 576
        length = (144 if version == 1 else 72) * bitrate // rate + ((b2 >> 1) & 1)
        samples += per_frame
        pos += length
    return round(samples / rate, 2) if rate else None


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


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--out', type=Path, default=ROOT / 'public' / 'music')
    parser.add_argument('--require', action='store_true',
                        help='exit with an error (and what to do) unless every background track is there')
    parser.add_argument('--offline', action='store_true', help="don't contact the wiki; only list the files already there")
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    manifest_path = out / 'manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.exists() else {}
    except ValueError:
        manifest = {}
    # MP3s copied in by hand (without their manifest) count as there.
    for slug in FILES:
        dest = out / f'{slug}.mp3'
        if slug not in manifest and dest.exists():
            seconds = mp3_seconds(dest.read_bytes())
            if seconds:
                manifest[slug] = {'duration': seconds, 'bytes': dest.stat().st_size}

    missing = [slug for slug in FILES if slug not in manifest or not (out / f'{slug}.mp3').exists()]
    if missing and not args.offline:
        try:
            urls = file_urls(FILES[slug] for slug in missing)
        except (OSError, ValueError, KeyError) as e:
            print(f'wiki_music: cannot reach https://deadlock.wiki ({e})', file=sys.stderr)
            urls = None
        for slug in missing if urls is not None else []:
            title = FILES[slug]
            url = urls.get(title)
            if not url:
                print(f'wiki_music: {title} is no longer on the wiki', file=sys.stderr)
                continue
            try:
                data = get(url, 120)
            except OSError as e:
                print(f'wiki_music: {title}: {e}', file=sys.stderr)
                continue
            seconds = mp3_seconds(data)
            if not seconds:
                print(f'wiki_music: {title} is not an MP3, skipped', file=sys.stderr)
                continue
            (out / f'{slug}.mp3').write_bytes(data)
            manifest[slug] = {'duration': seconds, 'bytes': len(data)}
            time.sleep(0.2)  # be gentle with the wiki

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
