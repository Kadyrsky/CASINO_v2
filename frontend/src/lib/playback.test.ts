import { describe, expect, it } from 'vite-plus/test';
import { CATCH_UP, LAG, advance, liveClock, type PlayClock } from './playback';

/** Runs the clock for `seconds` in steps of 1/10 s while frames keep arriving (the newest `latest` one moving too). */
function run(clock: PlayClock, from: { oldest: number; latest: number }, seconds: number, paused: boolean) {
  let c = clock;
  let { oldest, latest } = from;
  for (let i = 0; i < seconds * 10; i++) {
    latest += 0.1;
    oldest += 0.1;
    c = advance(c, oldest, latest, 0.1, paused);
  }
  return { clock: c, oldest, latest };
}

describe('advance', () => {
  it('starts a little behind the newest frame and keeps that distance', () => {
    const c = advance({ time: null, held: false }, 100, 200, 0.016, false);
    expect(c.time).toBeCloseTo(200 - LAG + 0.016, 6);
    const later = run(c, { oldest: 100, latest: 200 }, 30, false);
    expect(later.latest - later.clock.time!).toBeCloseTo(LAG - 0.016, 1);
  });

  it('catches up after falling far behind without pausing (a background tab)', () => {
    const c = advance({ time: 150, held: false }, 100, 200, 0.016, false);
    expect(c.time).toBeCloseTo(200 - LAG + 0.016, 6);
  });

  it('holds the picture while paused, longer than the catch-up limit', () => {
    const start = advance({ time: 197, held: false }, 100, 200, 0.016, true);
    const after = run(start, { oldest: 100, latest: 200 }, CATCH_UP + 20, true);
    expect(after.clock.time).toBe(197);
    expect(after.clock.held).toBe(true);
  });

  it('plays on from where it was paused, staying that far behind', () => {
    const paused = run({ time: 197, held: false }, { oldest: 100, latest: 200 }, 30, true);
    const playing = run(paused.clock, paused, 10, false);
    expect(playing.clock.time).toBeCloseTo(207, 6);
    expect(playing.latest - playing.clock.time!).toBeCloseTo(33, 6);
  });

  it('keeps to the oldest frame when paused for longer than the frames are kept', () => {
    const c = advance({ time: 120, held: true }, 130, 200, 0.016, true);
    expect(c.time).toBe(130);
  });

  it('goes back to the normal rules once the feed lets it catch up', () => {
    // Played on after a pause, then the feed stalled (no newer frames): the clock reaches the newest frame.
    const c = advance({ time: 199.5, held: true }, 100, 200, 0.5, false);
    expect(c).toEqual({ time: 200, held: false });
  });

  it('⏭ Live jumps to just behind the newest frame', () => {
    expect(liveClock(200)).toEqual({ time: 199, held: false });
  });
});
