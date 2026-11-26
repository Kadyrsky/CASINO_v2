/**
 * The music files this server has. scripts/wiki_music.py downloads them to /music; /music/manifest.json lists them
 * (with their exact lengths and loudness), and only packs whose files are there are offered, so a server without
 * them simply has no music. The packs themselves are in musicPacks.ts.
 *
 * The files differ in loudness by up to 25 dB, so every track and stinger is played at a gain that brings it to the
 * same loudness, and each pack's taste-test preview is a stretch of typical loudness. Otherwise a pack could win the
 * taste test (or lose to "turn the music off") just by being louder or quieter.
 */
import { createRoot, createResource } from 'solid-js';
import type { LoopTrack } from './musicPlayer';
import { musicPack, type MusicVersion } from './musicPacks';

/** Background tracks are evened out to this loudness (LUFS); stingers to their event's level (soundPacks.ts). */
const MUSIC_TARGET = -18;

/**
 * Loudness of the current wiki files (LUFS, as scripts/wiki_music.py measured them with ffmpeg in November 2026),
 * for a manifest without measurements (a developer without ffmpeg). The manifest's own value wins.
 */
export const MEASURED: Record<string, number> = {
  title: -10.3, 'hideout-base': -16.3, 'hideout-low': -22.7, 'hideout-high': -13.7, 'search-wait': -28.6,
  'connecting-old': -14.6, hotel: -32.5, 'hotel-far': -28.7, curio: -20.2, 'curio-alt': -18.3, 'winter-menu': -16.4,
  'winter-shop': -19.5, 'winter-secret': -28.8, waltz: -23.7, choir: -24.0, teleporter: -15.0, 'teleporter-comp': -15.1,
  'teleporter-melody': -24.4, price: -19.7, 'ks-01': -8.8, 'ks-02': -9.6, 'ks-03': -9.5, 'ks-04': -8.8, 'ks-05': -8.4,
  'ks-06': -8.4, 'ks-07': -8.5, 'ks-08': -8.3, 'ks-09': -8.4, 'ks-10': -8.0, 'first-blood': -9.2, 'urn-arrived': -13.4,
  'urn-delivered': -11.7, 'rift-announce': -12.0, 'rift-secured': -9.1, victory: -6.9, defeat: -8.6, 'rejuv-won': -9.5,
  'rejuv-lost': -14.1, 'guardian-down': -10.7, transition: -14.8,
};

export type Manifest = Record<string, { duration: number; lead?: number; bytes: number; lufs?: number }>;

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

/** The track a version plays (looped over its exact length), if this server has its file. */
export function versionTrack(v: MusicVersion): LoopTrack | null {
  const info = manifest()?.[v.slug];
  if (!info) return null;
  return { id: v.slug, url: musicFiles.url(v.slug), gain: musicFiles.musicGain(v.slug), duration: info.duration, lead: info.lead ?? 0 };
}

/** The version of a pack to play: the one asked for, or, if its file is missing here, the first the server has. */
export function packVersion(pack: string, version: string | null): MusicVersion | null {
  const versions = musicPack(pack)?.versions ?? [];
  const asked = versions.find((v) => v.id === version);
  return asked && musicFiles.has(asked.slug) ? asked : (versions.find((v) => musicFiles.has(v.slug)) ?? null);
}

/** Whether a pack can be played here (at least one of its files is on the server). */
export const packAvailable = (pack: string) => !!musicPack(pack)?.versions.some((v) => musicFiles.has(v.slug));

/** Whether a version of a pack can be played here. */
export const versionAvailable = (pack: string, version: string) =>
  !!musicPack(pack)?.versions.some((v) => v.id === version && musicFiles.has(v.slug));
