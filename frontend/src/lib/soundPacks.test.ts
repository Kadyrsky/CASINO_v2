import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NoiseOptions, ToneOptions, Voice } from './audio';
import { experiment } from './experimentRegistry';
import { LEVELS, PACKS, type SoundEvent } from './soundPacks';

const here = (path: string) => new URL(`../../${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(here('public/music/manifest.json'), 'utf8')) as Record<string, unknown>;
const events = Object.keys(LEVELS) as SoundEvent[];

/** A voice that checks what a recipe asks for and records when its sound ends. */
function recorder() {
  let end = 0;
  const check = (o: { at?: number; dur: number; gain?: number }) => {
    expect(o.dur).toBeGreaterThan(0);
    expect(o.at ?? 0).toBeGreaterThanOrEqual(0);
    expect(o.gain ?? 0.2).toBeGreaterThan(0);
    expect(o.gain ?? 0.2).toBeLessThanOrEqual(1);
    end = Math.max(end, (o.at ?? 0) + o.dur);
  };
  const voice: Voice = {
    tone(o: ToneOptions) {
      check(o);
      expect(Number.isFinite(o.f) && o.f > 20 && o.f < 20000).toBe(true);
    },
    noise(o: NoiseOptions) {
      check(o);
    },
  };
  return { voice, end: () => end };
}

describe('the sound packs', () => {
  it('are the sfx_pack experiment’s versions, Christmas included', () => {
    expect(Object.keys(PACKS).sort()).toEqual(experiment('sfx_pack').variants.map((v) => v.id).sort());
    expect(PACKS.christmas).toBeDefined();
  });

  it('have a sound for every event that plays (valid notes, sensible gains)', () => {
    for (const [id, pack] of Object.entries(PACKS)) {
      for (const event of events) {
        const r = recorder();
        expect(() => pack.sounds[event](r.voice, event === 'streak' ? 4 : 1), `${id} ${event}`).not.toThrow();
      }
    }
  });

  it('keep the Christmas sounds short: clicks a fraction of a second, the jackpot a few seconds', () => {
    const length = (event: SoundEvent) => {
      const r = recorder();
      PACKS.christmas!.sounds[event](r.voice, 0);
      return r.end();
    };
    for (const event of ['click', 'tap', 'select', 'toggle', 'open', 'close'] as const) expect(length(event), event).toBeLessThanOrEqual(0.5);
    for (const event of events) expect(length(event), event).toBeLessThanOrEqual(3.5);
  });

  it('play stingers that are committed in the music folder', () => {
    for (const [id, pack] of Object.entries(PACKS)) {
      for (const [event, slugOf] of Object.entries(pack.stingers ?? {})) {
        for (const n of [0, 1, 3, 10, 12]) expect(manifest[slugOf!(n)], `${id} ${event} ${n}`).toBeDefined();
      }
    }
  });

  it('switch themes with a soft cue: the title screen’s swell, cut short, with the music only slightly lowered', () => {
    const deadlock = PACKS.deadlock!;
    expect([0, 1, 2, 3].map((n) => deadlock.stingers?.theme?.(n))).toEqual(['transition', 'transition', 'transition', 'transition']);
    expect(deadlock.stingerMax?.theme).toBeLessThanOrEqual(5);
    expect(deadlock.stingerDuck?.theme).toBeGreaterThanOrEqual(0.5);
    expect(LEVELS.theme).toBeLessThan(LEVELS.notify); // quieter than a notification
    // The Patrons' match intros (loud brass) are gone.
    expect(manifest['king-intro']).toBeUndefined();
    expect(manifest['mother-intro']).toBeUndefined();
  });
});
