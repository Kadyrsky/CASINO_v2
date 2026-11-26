import { describe, expect, it } from 'vitest';
import { CROSSFADE, loopPoints, MusicPlayer, type Loaded, type LoopTrack, type MusicOutput, type PlayerState, type Voice } from './musicPlayer';

const track = (id: string, duration = 40): LoopTrack => ({ id, url: `/music/${id}.mp3`, gain: 0.8, duration, lead: 0.025 });
const A = track('a');
const B = track('b');
const C = track('c');
const D = track('d');

class FakeVoice implements Voice {
  gain = 0;
  stopped = false;
  private readonly started: number;
  constructor(
    readonly id: string,
    private readonly offset: number,
    private readonly out: FakeOutput,
  ) {
    this.started = out.now;
  }
  position() {
    return this.offset + (this.out.now - this.started) / 1000;
  }
  fade(gain: number) {
    if (this.stopped) throw new Error(`${this.id} faded after it stopped`);
    this.gain = gain;
  }
  stop() {
    this.stopped = true;
  }
}

/** An output with loads we finish by hand and a clock we move by hand. */
class FakeOutput implements MusicOutput {
  now = 0;
  loads: { track: LoopTrack; signal: AbortSignal; finish: (ok: boolean) => void }[] = [];
  voices: FakeVoice[] = [];
  disposed: string[] = [];
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  load(t: LoopTrack, signal: AbortSignal) {
    return new Promise<Loaded | null>((resolve) =>
      this.loads.push({
        track: t,
        signal,
        finish: (ok) =>
          resolve(
            ok
              ? {
                  start: (offset) => {
                    const v = new FakeVoice(t.id, offset, this);
                    this.voices.push(v);
                    return v;
                  },
                  dispose: () => this.disposed.push(t.id),
                }
              : null,
          ),
      }),
    );
  }
  later(fn: () => void, ms: number) {
    const timer = { at: this.now + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => void (timer.cancelled = true);
  }
  advance(ms: number) {
    this.now += ms;
    for (const t of this.timers.filter((x) => !x.cancelled && x.at <= this.now)) {
      t.cancelled = true;
      t.fn();
    }
  }
  /** Finishes the latest load of a track. */
  async finish(id: string, ok = true) {
    [...this.loads].reverse().find((l) => l.track.id === id)!.finish(ok);
    await settle();
  }
  sounding() {
    return this.voices.filter((v) => !v.stopped);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const out = new FakeOutput();
  const states: PlayerState[] = [];
  const player = new MusicPlayer(out, (s) => states.push(s));
  return { out, player, states, state: () => player.getState() };
}

describe('the music player', () => {
  it('plays a track once it has loaded, fading it in', async () => {
    const { out, player, state } = setup();
    player.play(A);
    expect(state()).toMatchObject({ track: A, loading: true, playing: false });
    await out.finish('a');
    expect(out.sounding().map((v) => [v.id, v.gain])).toEqual([['a', A.gain]]);
    expect(state()).toMatchObject({ playing: true, audible: true, loading: false });
  });

  it('keeps the old track playing while the next one loads, then cross-fades', async () => {
    const { out, player, state } = setup();
    player.play(A);
    await out.finish('a');
    player.play(B);
    expect(out.sounding().map((v) => v.id)).toEqual(['a']);
    expect(state()).toMatchObject({ track: B, playing: false, audible: true, loading: true });
    await out.finish('b');
    expect(out.sounding().map((v) => [v.id, v.gain])).toEqual([
      ['a', 0],
      ['b', B.gain],
    ]);
    out.advance(CROSSFADE * 1000 + 100);
    expect(out.sounding().map((v) => v.id)).toEqual(['b']);
  });

  it('never lets tracks pile up when switched quickly', async () => {
    const { out, player, state } = setup();
    player.play(A);
    await out.finish('a');
    // Click, click, click: each new pack cancels the one still loading.
    player.play(B);
    player.play(C);
    player.play(D);
    expect(out.loads.map((l) => [l.track.id, l.signal.aborted])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d', false],
    ]);
    // A cancelled load that finishes anyway never starts (and lets go of what it loaded).
    await out.finish('c');
    await out.finish('b');
    expect(out.voices.map((v) => v.id)).toEqual(['a']);
    expect(out.disposed).toEqual(['c', 'b']);
    await out.finish('d');
    expect(out.voices.map((v) => v.id)).toEqual(['a', 'd']);
    expect(state()).toMatchObject({ track: D, playing: true });

    // Switching faster than the cross-fade, with every track ready at once: still never more than two.
    for (const t of [A, B, C, D, A, C]) {
      player.play(t);
      await out.finish(t.id);
      expect(out.sounding().length).toBeLessThanOrEqual(2);
      expect(player.voices).toBe(out.sounding().length);
      out.advance(300);
    }
    out.advance(CROSSFADE * 1000 + 100);
    expect(out.sounding().map((v) => [v.id, v.gain])).toEqual([['c', C.gain]]);
  });

  it('brings back the track fading out, from where it is, if it is asked for again', async () => {
    const { out, player } = setup();
    player.play(A);
    await out.finish('a');
    out.advance(5000);
    player.play(B);
    await out.finish('b');
    out.advance(1000);
    player.play(A);
    const [a, b] = out.voices;
    expect(out.voices).toHaveLength(2); // no new voice for A
    expect([a!.stopped, a!.gain, b!.gain]).toEqual([false, A.gain, 0]);
    expect(a!.position()).toBeCloseTo(6);
    out.advance(CROSSFADE * 1000 + 100);
    expect(out.sounding().map((v) => v.id)).toEqual(['a']);
  });

  it('pauses where it is and carries on from there', async () => {
    const { out, player, state } = setup();
    player.play(A);
    await out.finish('a');
    out.advance(12_000);
    player.pause();
    expect(state()).toMatchObject({ playing: false, audible: false });
    out.advance(2000);
    expect(out.sounding()).toEqual([]);
    player.resume();
    await out.finish('a');
    expect(out.sounding().map((v) => [v.id, v.gain])).toEqual([['a', A.gain]]);
    expect(out.sounding()[0]!.position()).toBeCloseTo(12);
  });

  it('starts a track that loaded while paused only when playing again', async () => {
    const { out, player } = setup();
    player.play(A);
    player.pause();
    await out.finish('a');
    expect(out.voices).toEqual([]);
    player.resume();
    expect(out.sounding().map((v) => v.id)).toEqual(['a']);
  });

  it('keeps the old track playing if the new one fails to load', async () => {
    const { out, player, state } = setup();
    player.play(A);
    await out.finish('a');
    player.play(B);
    await out.finish('b', false);
    expect(state()).toMatchObject({ track: B, failed: true, playing: false, audible: true });
    expect(out.sounding().map((v) => v.id)).toEqual(['a']);
  });

  it('does nothing when asked for the track it is playing', async () => {
    const { out, player, states } = setup();
    player.play(A);
    await out.finish('a');
    const before = states.length;
    player.play(A);
    player.play(track('a'));
    expect(out.loads).toHaveLength(1);
    expect(out.voices).toHaveLength(1);
    expect(states).toHaveLength(before);
  });

  it('stops everything', async () => {
    const { out, player, state } = setup();
    player.play(A);
    await out.finish('a');
    player.play(B);
    player.stop();
    out.advance(1000);
    expect(out.sounding()).toEqual([]);
    expect(out.loads[1]!.signal.aborted).toBe(true);
    expect(state()).toMatchObject({ track: null, playing: false, loading: false });
  });
});

describe('loop points', () => {
  const hideout = { duration: 43.354853, lead: 0.025057 };

  it('loops the whole buffer when the decoder took the encoder’s silence out', () => {
    expect(loopPoints(43.354853, hideout)).toEqual([0, 43.354853]);
  });

  it('loops the audio inside the buffer when the silence was left in', () => {
    const untrimmed = 1661 * 1152 / 44100; // every frame decoded
    const [start, end] = loopPoints(untrimmed, hideout);
    expect(start).toBeCloseTo(0.025057, 6);
    expect(end - start).toBeCloseTo(43.354853, 6);
  });

  it('falls back to the whole buffer when it can’t tell', () => {
    expect(loopPoints(30, hideout)).toEqual([0, 30]);
    expect(loopPoints(12, { duration: 0, lead: 0 })).toEqual([0, 12]);
  });
});
