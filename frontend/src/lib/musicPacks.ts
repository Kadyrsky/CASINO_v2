/**
 * The music packs: Deadlock's music (https://deadlock.wiki/Music), grouped as the wiki groups it. A pack is a version
 * of the `music_pack` experiment, and a pack with several versions of its track (the hideout loop's tempos, the
 * Baroness Hotel heard near or far...) is an experiment of its own, `music_<pack>`, so both the pack and the version
 * within it are A/B tested (experiments.ts). Plain data, so the tests can read it without a browser.
 *
 * Each version is one file (its slug in scripts/wiki_music.py), played in a loop.
 */

export interface MusicVersion {
  /** The version's id in its experiment (snake_case). */
  id: string;
  label: string;
  /** The file: public/music/<slug>.mp3. */
  slug: string;
  /** What the taste test plays: 12 seconds from here, a stretch of typical loudness (seconds). */
  preview: number;
}

export interface MusicPack {
  /** The pack's id in the `music_pack` experiment. */
  id: string;
  title: string;
  note: string;
  versions: MusicVersion[];
}

export const MUSIC_PACKS: MusicPack[] = [
  {
    id: 'deadlock',
    title: 'Deadlock',
    note: 'The title screen',
    versions: [{ id: 'title', label: 'Title Screen', slug: 'title', preview: 17.5 }],
  },
  {
    id: 'hideout',
    title: 'Hideout',
    note: 'The hideout’s trip-hop loop',
    // Layers of one loop: the same 12 seconds of each, so they are compared like for like.
    versions: [
      { id: 'base', label: 'Base', slug: 'hideout-base', preview: 13.5 },
      { id: 'low', label: 'Low Tempo', slug: 'hideout-low', preview: 13.5 },
      { id: 'high', label: 'High Tempo', slug: 'hideout-high', preview: 13.5 },
    ],
  },
  {
    id: 'matchmaking',
    title: 'Matchmaking Search',
    note: 'Waiting for a match',
    versions: [
      { id: 'wait', label: 'Wait', slug: 'search-wait', preview: 98 },
      // The retired "Connecting to Match", which played while a match loaded.
      { id: 'retired', label: 'Retired', slug: 'connecting-old', preview: 71.5 },
    ],
  },
  {
    id: 'hotel',
    title: 'The Baroness Hotel',
    note: 'A jazz-age record',
    versions: [
      { id: 'near', label: 'Near', slug: 'hotel', preview: 28 },
      { id: 'far', label: 'Far', slug: 'hotel-far', preview: 28 },
    ],
  },
  {
    id: 'curio',
    title: 'The Curiosity Shop',
    note: 'Shop music',
    versions: [
      { id: 'standard', label: 'Standard', slug: 'curio', preview: 3 },
      { id: 'alternate', label: 'Alternate', slug: 'curio-alt', preview: 110.5 },
    ],
  },
  {
    id: 'seasonal',
    title: 'Seasonal',
    note: 'Limited time: the winter event',
    versions: [
      { id: 'menu', label: 'Main menu', slug: 'winter-menu', preview: 446 },
      { id: 'shop', label: 'Standard shop', slug: 'winter-shop', preview: 21 },
      { id: 'secret', label: 'Secret shop', slug: 'winter-secret', preview: 83 },
    ],
  },
  {
    id: 'waltz',
    title: 'Ambient Waltz',
    note: 'The greenhouse’s record',
    versions: [{ id: 'waltz', label: 'Waltz', slug: 'waltz', preview: 8.5 }],
  },
  {
    id: 'choir',
    title: 'Ambient Choir',
    note: 'An unused choir loop',
    versions: [{ id: 'choir', label: 'Choir', slug: 'choir', preview: 7 }],
  },
  {
    id: 'teleporter',
    title: 'Teleporter',
    note: 'Unused teleporter music',
    versions: [
      { id: 'main', label: 'Music 01', slug: 'teleporter', preview: 26 },
      { id: 'comp', label: 'Comp', slug: 'teleporter-comp', preview: 7 },
      { id: 'melody', label: 'Melody', slug: 'teleporter-melody', preview: 7 },
    ],
  },
  {
    id: 'price',
    title: 'Paying the Price',
    note: 'Cadence’s song, looped',
    // Cut at 49 s with the next 0.7 s mixed onto the start (scripts/wiki_music.py), so it loops without a seam.
    versions: [{ id: 'loop', label: 'Loop edit', slug: 'price', preview: 37 }],
  },
];

export const musicPack = (id: string): MusicPack | undefined => MUSIC_PACKS.find((p) => p.id === id);

/** The experiment that compares a pack's versions, if it has more than one. */
export const versionExperiment = (pack: string): string | null =>
  (musicPack(pack)?.versions.length ?? 0) > 1 ? `music_${pack}` : null;

/** The pack a version experiment belongs to ('music_hideout' → 'hideout'). */
export const packOfExperiment = (key: string): string | null => {
  const id = key.startsWith('music_') ? key.slice(6) : '';
  return id && versionExperiment(id) === key ? id : null;
};

/** A track's name for "now playing": the pack, and the version if there are several. */
export function trackTitle(slug: string): string {
  for (const p of MUSIC_PACKS) {
    const v = p.versions.find((x) => x.slug === slug);
    if (v) return p.versions.length > 1 ? `${p.title}: ${v.label}` : p.title;
  }
  return slug;
}
