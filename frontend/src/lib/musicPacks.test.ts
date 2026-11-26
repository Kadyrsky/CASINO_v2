import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, experiment } from './experimentRegistry';
import { MEASURED } from './musicCatalog';
import { MUSIC_PACKS, packOfExperiment, trackTitle, versionExperiment } from './musicPacks';

const here = (path: string) => new URL(`../../${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(here('public/music/manifest.json'), 'utf8')) as Record<string, { duration: number; lead?: number; lufs?: number }>;
const script = readFileSync(here('scripts/wiki_music.py'), 'utf8');
/** The slugs in a dict of scripts/wiki_music.py (TRACKS or STINGERS). */
const slugsOf = (dict: string) => [...(script.split(`${dict}: dict`)[1]!.split('\n}\n')[0]!.matchAll(/^\s+'([a-z0-9-]+)':/gm))].map((m) => m[1]!);
const NAME = /^[a-z0-9_]{1,40}$/; // what the core accepts as an experiment or variant name

describe('the music packs', () => {
  const versions = MUSIC_PACKS.flatMap((p) => p.versions.map((v) => ({ pack: p, ...v })));

  it('are the ten packs asked for, with their versions', () => {
    expect(MUSIC_PACKS.map((p) => [p.id, p.versions.map((v) => v.id)])).toEqual([
      ['deadlock', ['title']],
      ['hideout', ['base', 'low', 'high']],
      ['matchmaking', ['wait', 'retired']],
      ['hotel', ['near', 'far']],
      ['curio', ['standard', 'alternate']],
      ['seasonal', ['menu', 'shop', 'secret']],
      ['waltz', ['waltz']],
      ['choir', ['choir']],
      ['teleporter', ['main', 'comp', 'melody']],
      ['price', ['loop']],
    ]);
  });

  it('play files that are committed, listed in the manifest and fetched by the import script', () => {
    const tracks = slugsOf('TRACKS');
    for (const v of versions) {
      expect(manifest[v.slug], v.slug).toBeDefined();
      expect(tracks, v.slug).toContain(v.slug);
    }
    // ...and the import fetches nothing the packs don't play.
    expect([...tracks].sort()).toEqual(versions.map((v) => v.slug).sort());
  });

  it('loop over each file’s exact length: Paying the Price is cut at exactly 49 s', () => {
    expect(manifest.price!.duration).toBe(49);
    // Each file's gapless header was read, so the loop is found even in a decode that keeps the encoder's silence.
    for (const v of versions) expect(manifest[v.slug]!.lead, v.slug).toSatisfy((lead: number) => lead > 0 && lead < 0.1);
  });

  it('preview 12 seconds that fit in each track', () => {
    for (const v of versions) {
      expect(v.preview, v.slug).toBeGreaterThanOrEqual(0);
      expect(v.preview + 12, v.slug).toBeLessThanOrEqual(manifest[v.slug]!.duration);
    }
  });

  it('have the loudness measured, for evening them out', () => {
    for (const [slug, info] of Object.entries(manifest)) expect(MEASURED[slug], slug).toBe(info.lufs);
  });

  it('name tracks by pack and version', () => {
    expect(trackTitle('hideout-low')).toBe('Hideout: Low Tempo');
    expect(trackTitle('price')).toBe('Paying the Price');
  });
});

describe('the music experiments', () => {
  it('compare the packs, and the versions within each pack that has several', () => {
    expect(experiment('music_pack').variants.map((v) => v.id)).toEqual(MUSIC_PACKS.map((p) => p.id));
    const withVersions = MUSIC_PACKS.filter((p) => p.versions.length > 1);
    expect(EXPERIMENTS.filter((e) => e.parent).map((e) => e.key)).toEqual(withVersions.map((p) => `music_${p.id}`));
    for (const p of withVersions) {
      const e = experiment(versionExperiment(p.id)!);
      expect(e.parent).toEqual({ key: 'music_pack', variant: p.id });
      expect(e.variants.map((v) => v.id)).toEqual(p.versions.map((v) => v.id));
      expect(e.taste?.tryBy).toBe('listen');
      expect(e.primary).toEqual({ metric: 'music_off', better: 'lower' });
      expect(packOfExperiment(e.key)).toBe(p.id);
    }
    expect(versionExperiment('price')).toBeNull();
    expect(packOfExperiment('music_pack')).toBeNull();
  });

  it('use names the core accepts, and fit in one assignments request', () => {
    for (const e of EXPERIMENTS) {
      expect(e.key).toMatch(NAME);
      for (const v of e.variants) expect(v.id).toMatch(NAME);
    }
    expect(EXPERIMENTS.length).toBeLessThanOrEqual(20);
  });

  it('take the Classic theme out, and add Christmas for new visitors only', () => {
    const theme = experiment('theme');
    expect(theme.variants.map((v) => v.id)).toEqual(['hidden_king', 'archmother', 'deadlock', 'christmas']);
    expect(theme.variants.find((v) => v.id === 'christmas')?.since).toBe(2);
    expect(theme.retired?.map((v) => v.id)).toEqual(['classic']);
  });
});
