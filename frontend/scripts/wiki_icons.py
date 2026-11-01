"""Downloads item, ability and objective icons from the Deadlock Wiki (deadlock.wiki) for the realtime map.

    python scripts/wiki_icons.py        (from frontend/, needs Pillow: pip install pillow)

Writes 64 px WebP copies to public/icons/ and the name -> file table to src/lib/wikiIcons.ts. Run it again when
new items come out. The images are Valve's game art as hosted by the wiki (https://deadlock.wiki).
"""
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

API = 'https://deadlock.wiki/api.php'
# The site's item list (the watcher's source too), for items the wiki's icon category misses.
ITEMS = 'https://api.deadlock-api.com/v1/assets/items'
UA = {'User-Agent': 'naebka-icons/1.0 (student project; occasional icon import)'}
SIZE = 64
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'icons'

# Objective kind (as the bot reports it) -> wiki file. The wiki has no minimap icons for guardians and walkers, so
# their infobox icons are used; patrons use each team's glyph and the Mid-Boss the Rejuvenator it drops.
OBJECTIVES = {
    'guardian': 'Guardian.png',
    'walker': 'Walker Icon.png',
    'patron-0': 'Hidden King alt icon.png',
    'patron-1': 'Archmother alt icon.png',
    'midboss': 'Rejuvenator.png',
    'rift': 'Unstable Rift.png',
    'urn': 'Soul Urn.png',
}


def api(**params):
    url = API + '?' + urllib.parse.urlencode({'format': 'json', **params})
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def category_files(category):
    files, cont = {}, {}
    while True:
        d = api(action='query', generator='categorymembers', gcmtitle='Category:' + category, gcmtype='file',
                gcmlimit='500', prop='imageinfo', iiprop='url', **cont)
        for p in d.get('query', {}).get('pages', {}).values():
            if p.get('imageinfo'):
                files[p['title'].removeprefix('File:')] = p['imageinfo'][0]['url']
        if 'continue' not in d:
            return files
        cont = d['continue']


def file_urls(titles, min_width=0, max_width=10_000):
    """URLs of the wiki files that exist among `titles` and are min_width to max_width px wide (asked 50 at a time)."""
    titles, urls = list(titles), {}
    for i in range(0, len(titles), 50):
        d = api(action='query', titles='|'.join('File:' + t for t in titles[i:i + 50]), prop='imageinfo', iiprop='url|size')
        # The API reports titles with underscores turned back into spaces; map them back to what was asked.
        asked = {t.replace('_', ' '): t for t in titles[i:i + 50]}
        for p in d['query']['pages'].values():
            if p.get('imageinfo') and min_width <= p['imageinfo'][0]['width'] <= max_width:
                title = p['title'].removeprefix('File:')
                urls[asked.get(title, title)] = p['imageinfo'][0]['url']
    return urls


def asset_names():
    """Shop item names and hero ability names (signature and ultimate), from deadlock-api."""
    with urllib.request.urlopen(urllib.request.Request(ITEMS, headers=UA), timeout=60) as r:
        rows = json.load(r)
    items = sorted({i['name'] for i in rows if i.get('type') == 'upgrade' and i.get('name')})
    abilities = sorted({i['name'] for i in rows if i.get('type') == 'ability' and i.get('name')
                        and i.get('ability_type') in ('signature', 'ultimate')})
    return items, abilities


def import_icons(category, folder, names, size_range):
    """The category's icons, plus those of `names` it misses whose file (named after them) is `size_range` px wide."""
    icons = {}
    for title, url in sorted(category_files(category).items()):
        name = re.sub(r'\s*\((item|ability)\)$', '', title.rsplit('.', 1)[0])
        save_icon(url, OUT / folder / f'{slug(name)}.webp')
        icons[key(name)] = slug(name)
    from_category = len(icons)
    others = [n for n in names if key(n) not in icons]
    found = file_urls((f'{n}.png' for n in others), *size_range)
    for name in others:
        if f'{name}.png' in found:
            save_icon(found[f'{name}.png'], OUT / folder / f'{slug(name)}.webp')
            icons[key(name)] = slug(name)
    print(f'{folder}: {from_category} icons from the category, {len(icons)} in all')
    return icons


def save_icon(url, dest):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        im = Image.open(io.BytesIO(r.read())).convert('RGBA')
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    square = Image.new('RGBA', (SIZE, SIZE))
    square.alpha_composite(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2))
    dest.parent.mkdir(parents=True, exist_ok=True)
    square.save(dest, 'WEBP', quality=85, method=6)
    time.sleep(0.1)  # be gentle with the wiki


def key(name):
    """The lookup key the frontend uses (`wikiKey` in wikiIcons.ts): lower case letters and digits only."""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def main():
    item_names, ability_names = asset_names()
    # Many current items and abilities have an icon named after them that isn't in the category. Current item art
    # is 200 px (smaller files with an item's name are old glyphs); ability icons are 128-137 px (bigger files with
    # an ability's name are other pictures, like an item that shares the name).
    items = import_icons('Item_icons', 'items', item_names, (200, 10_000))
    abilities = import_icons('Ability_icons', 'abilities', ability_names, (100, 160))

    urls = file_urls(OBJECTIVES.values())
    for kind, title in OBJECTIVES.items():
        save_icon(urls[title], OUT / 'objectives' / f'{kind}.webp')
    print(f'{len(OBJECTIVES)} objective icons')

    lines = [
        '// Generated by scripts/wiki_icons.py from the Deadlock Wiki (https://deadlock.wiki): do not edit by hand.',
        '',
        '/** Item name (see `wikiKey`) -> icon file in /icons/items/. */',
        'export const ITEM_ICONS: Record<string, string> = {',
        *[f"  {k}: '{v}'," for k, v in sorted(items.items())],
        '};',
        '',
        '/** Hero ability name (see `wikiKey`) -> icon file in /icons/abilities/. */',
        'export const ABILITY_ICONS: Record<string, string> = {',
        *[f"  {k}: '{v}'," for k, v in sorted(abilities.items())],
        '};',
        '',
        '/** The lookup key of an item name: lower case letters and digits only. */',
        'export function wikiKey(name: string): string {',
        "  return name.toLowerCase().replace(/[^a-z0-9]/g, '');",
        '}',
        '',
    ]
    (ROOT / 'src' / 'lib' / 'wikiIcons.ts').write_text('\n'.join(lines), encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
