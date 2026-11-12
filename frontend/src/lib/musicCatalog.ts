/**
 * Deadlock's music (https://deadlock.wiki/Music), grouped into stations: the variants of the `music` experiment.
 * scripts/wiki_music.py downloads the files to /music; /music/manifest.json lists the ones this server has (with
 * their lengths and loudness), and only those are offered, so a server without them simply has no music.
 *
 * The files differ in loudness by up to 25 dB, so every track and stinger is played at a gain that brings it to the
 * same loudness, and each station's taste-test preview is a stretch of typical loudness. Otherwise a station could
 * win the taste test (or lose to "turn the music off") just by being louder or quieter.
 */
import { createRoot, createResource } from 'solid-js';
import type { MusicTrack } from './audio';

export interface Station {
  title: string;
  note: string;
  /** Track slugs (scripts/wiki_music.py) and their names, in play order. */
  tracks: [string, string][];
  /** What the taste test plays: a track and where its 12 seconds start, a stretch of typical loudness. */
  preview: [string, number];
}

export const STATIONS: Record<string, Station> = {
  lounge: {
    title: 'Lounge',
    note: 'Jazz-age records',
    tracks: [['hotel', 'The Baroness Hotel'], ['curio', 'The Curiosity Shop'], ['waltz', 'Greenhouse Waltz'], ['rem', 'Rem’s Record']],
    preview: ['hotel', 28],
  },
  hideout: {
    title: 'Hideout',
    note: 'The trip-hop theme',
    tracks: [['title', 'Title Screen'], ['hideout', 'The Hideout'], ['postgame', 'Post-Game'], ['draft', 'Street Brawl Draft']],
    preview: ['title', 15],
  },
  gothic: {
    title: 'Gothic',
    note: 'The original score',
    tracks: [['menu-old', 'Old Main Menu'], ['choir', 'Choir'], ['vault', 'Sinner’s Sacrifice']],
    preview: ['menu-old', 8],
  },
  rift: {
    title: 'Rift Fight',
    note: 'Battle loops',
    tracks: [['rift', 'Rift Capture'], ['urn', 'Soul Urn Run'], ['core', 'Base Under Attack']],
    preview: ['rift', 4],
  },
};

/** Background tracks are evened out to this loudness (LUFS); stingers to their event's level (soundPacks.ts). */
const MUSIC_TARGET = -18;

/**
 * Loudness of the current wiki files (LUFS, as scripts/wiki_music.py measured them with ffmpeg in November 2026),
 * for a manifest without measurements (a developer without ffmpeg). The manifest's own value wins.
 */
const MEASURED: Record<string, number> = {
  hotel: -32.5, curio: -20.2, waltz: -23.7, rem: -20.0, title: -10.3, hideout: -16.3, postgame: -7.5, draft: -8.5,
  'menu-old': -13.9, choir: -24.0, vault: -21.3, rift: -9.1, urn: -16.6, core: -13.0, 'ks-01': -8.8, 'ks-02': -9.6,
  'ks-03': -9.5, 'ks-04': -8.8, 'ks-05': -8.4, 'ks-06': -8.4, 'ks-07': -8.5, 'ks-08': -8.3, 'ks-09': -8.4,
  'ks-10': -8.0, 'first-blood': -9.2, 'urn-arrived': -13.4, 'urn-delivered': -11.7, 'rift-announce': -12.0,
  'rift-secured': -9.1, victory: -6.9, defeat: -8.6, 'rejuv-won': -9.5, 'rejuv-lost': -14.1, 'guardian-down': -10.7,
  'king-intro': -10.4, 'mother-intro': -11.6,
};

type Manifest = Record<string, { duration: number; bytes: number; lufs?: number }>;

const manifest = createRoot(() => {
  const [data] = createResource<Manifest>(() =>
    fetch('/music/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : {}))
      .catch(() => ({})),
  );
  return data;
});

/** A file's loudness (LUFS): measured by the build, or the table above. */
const loudness = (slug: string) => manifest()?.[slug]?.lufs ?? MEASURED[slug] ?? MUSIC_TARGET;

export const musicFiles = {
  /** True once the manifest has been read (whether or not it lists anything). */
  ready: () => manifest() !== undefined,
  has: (slug: string) => !!manifest()?.[slug],
  duration: (slug: string) => manifest()?.[slug]?.duration ?? 0,
  url: (slug: string) => `/music/${slug}.mp3`,
  loudness,
  /** Playback gain that brings a background track to the common loudness (within -12..+20 dB). */
  musicGain: (slug: string) => 10 ** (Math.min(20, Math.max(-12, MUSIC_TARGET - loudness(slug))) / 20),
};

/** The station's tracks this server has. Short loops repeat, so each plays for a minute and a half or so. */
export function stationTracks(station: string): MusicTrack[] {
  return (STATIONS[station]?.tracks ?? [])
    .filter(([slug]) => musicFiles.has(slug))
    .map(([slug]) => ({
      id: slug,
      url: musicFiles.url(slug),
      repeat: Math.min(4, Math.max(1, Math.ceil(90 / Math.max(1, musicFiles.duration(slug))))),
      gain: musicFiles.musicGain(slug),
    }));
}

export function trackTitle(slug: string): string {
  for (const s of Object.values(STATIONS)) {
    const t = s.tracks.find(([id]) => id === slug);
    if (t) return t[1];
  }
  return slug;
}

/** Whether a station can be played here (at least one of its files is on the server). */
export const stationAvailable = (station: string) => stationTracks(station).length > 0;
