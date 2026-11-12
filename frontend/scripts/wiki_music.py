"""Downloads Deadlock's music and stingers from the Deadlock Wiki (https://deadlock.wiki/Music) for the site's
music player and the Deadlock sound pack.

    python scripts/wiki_music.py              (from frontend/; standard library only)
    python scripts/wiki_music.py --out DIR    (the core's Docker build uses this)

Writes public/music/<slug>.mp3 and public/music/manifest.json ({slug: {"duration": seconds, "bytes": n, "lufs": x}}).
The frontend (src/lib/musicCatalog.ts) only offers what the manifest lists, so a failed or partial download leaves the
site working, just with less music.

The tracks differ in loudness by up to 25 dB (the hotel's record is mixed far quieter than the title theme). If ffmpeg
is installed (the Docker build installs it), each file's integrated loudness (EBU R128, in LUFS) goes into the
manifest and the player evens them out, so in the taste test no station wins just by being louder.

The audio is Valve's, as hosted by the wiki. It is not committed to git (see .gitignore): the core's Docker build
fetches it, and developers run this script once for `vp dev`.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://deadlock.wiki/api.php'
UA = {'User-Agent': 'naebka-music/1.0 (student project; one-off music import)'}
ROOT = Path(__file__).resolve().parent.parent

# slug -> wiki file. Keep the slugs in sync with src/lib/musicCatalog.ts.
FILES = {
    # Background music (stations)
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
    # Stingers (the Deadlock sound pack)
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


def file_urls(titles):
    urls = {}
    titles = list(titles)
    for i in range(0, len(titles), 40):
        q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'formatversion': '2', 'prop': 'imageinfo',
                                    'iiprop': 'url', 'titles': '|'.join('File:' + t for t in titles[i:i + 40])})
        with urllib.request.urlopen(urllib.request.Request(f'{API}?{q}', headers=UA), timeout=60) as r:
            pages = json.load(r)['query']['pages']
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
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    manifest_path = out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.exists() else {}
    try:
        urls = file_urls(FILES.values())
    except OSError as e:
        print(f'wiki_music: cannot reach the wiki ({e}); keeping {len(manifest)} files already here', file=sys.stderr)
        urls = {}
    for slug, title in FILES.items():
        dest = out / f'{slug}.mp3'
        if dest.exists() and slug in manifest:
            continue
        url = urls.get(title)
        if not url:
            print(f'wiki_music: {title} not found on the wiki', file=sys.stderr)
            continue
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                data = r.read()
        except OSError as e:
            print(f'wiki_music: {title}: {e}', file=sys.stderr)
            continue
        seconds = mp3_seconds(data)
        if not seconds:
            print(f'wiki_music: {title} is not an MP3, skipped', file=sys.stderr)
            continue
        dest.write_bytes(data)
        manifest[slug] = {'duration': seconds, 'bytes': len(data)}
        time.sleep(0.2)  # be gentle with the wiki
    manifest = {k: manifest[k] for k in FILES if k in manifest}
    for slug, info in manifest.items():
        if 'lufs' not in info:
            lufs = loudness(out / f'{slug}.mp3')
            if lufs is not None:
                info['lufs'] = lufs
    manifest_path.write_text(json.dumps(manifest, indent=1) + '\n', encoding='utf-8', newline='\n')
    total = sum(m['bytes'] for m in manifest.values()) / 1e6
    measured = sum('lufs' in m for m in manifest.values())
    print(f'wiki_music: {len(manifest)}/{len(FILES)} files in {out} ({total:.1f} MB), loudness measured for {measured}'
          + ('' if measured else ' (install ffmpeg to measure it)'))


if __name__ == '__main__':
    main()
