/**
 * The background music player's logic: which track sounds, which one is loading, which one fades out. The sound itself
 * is made by an output (audio.ts: Web Audio), so this part is plain logic and is tested on its own (musicPlayer.test.ts).
 *
 * Switching quickly (theme, music pack, version) never piles tracks up or breaks playback:
 *   - one track sounds; at most one more fades out under it, and a third stops the fading one at once;
 *   - the track playing keeps playing while the next one loads, then they cross-fade;
 *   - asking for another track while one loads cancels that load: a superseded track never starts;
 *   - asking again for the track that is fading out brings it back where it is, without restarting it;
 *   - pausing (sound off, tab hidden) keeps the place, and playing again resumes there.
 */

export interface LoopTrack {
  /** The file's slug. */
  id: string;
  url: string;
  /** Playback gain that evens out the tracks' loudness. */
  gain: number;
  /** The audio's exact length in seconds; it loops at that point, so a loop has no gap. */
  duration: number;
  /** Where the audio starts in a decode that keeps the encoder's silence (scripts/wiki_music.py). */
  lead: number;
}

/** A track sounding on the output. */
export interface Voice {
  /** Seconds into the track. */
  position(): number;
  /** Ramps the volume to `gain` over `seconds`. */
  fade(gain: number, seconds: number): void;
  /** Stops now (with a few milliseconds' ramp, so it doesn't click) and frees what it held. */
  stop(): void;
}

/** A track ready to play. */
export interface Loaded {
  /** Starts it `offset` seconds in, silent until faded in. */
  start(offset: number): Voice;
  /** Lets go of it without playing it (a stream's <audio> element). */
  dispose(): void;
}

export interface MusicOutput {
  /** Gets a track ready (download, decode). Resolves null if it can't be played; may be cancelled with `signal`. */
  load(track: LoopTrack, signal: AbortSignal): Promise<Loaded | null>;
  /** Runs `fn` after `ms` milliseconds; returns a function that cancels it. */
  later(fn: () => void, ms: number): () => void;
}

export interface PlayerState {
  /** The track asked for (playing, loading or paused). */
  track: LoopTrack | null;
  /** The track asked for is sounding (or fading in). */
  playing: boolean;
  /** Some music is sounding: the track asked for, or the one before it while the new one loads. */
  audible: boolean;
  /** Loading the track asked for. */
  loading: boolean;
  /** The track asked for couldn't be loaded (the one before it keeps playing). */
  failed: boolean;
}

/** Seconds of cross-fade between two tracks, and of fading in from silence. */
export const CROSSFADE = 2.5;
export const FADE_IN = 1.5;

interface Sounding {
  track: LoopTrack;
  voice: Voice;
}

export class MusicPlayer {
  private wanted: LoopTrack | null = null;
  private wantPlay = false;
  private current: Sounding | null = null;
  private fading: (Sounding & { cancel: () => void }) | null = null;
  private loading: { track: LoopTrack; abort: AbortController } | null = null;
  /** A track loaded while paused, started on resume. */
  private ready: { track: LoopTrack; loaded: Loaded } | null = null;
  /** Where each track was when it was paused or switched away from: playing it again resumes there. */
  private places = new Map<string, number>();
  private failed = false;
  private state: PlayerState = { track: null, playing: false, audible: false, loading: false, failed: false };

  constructor(
    private readonly output: MusicOutput,
    private readonly onChange: (state: PlayerState) => void = () => {},
  ) {}

  /** Plays a track (looping), cross-fading from whatever plays now. Asking for the same track again does nothing. */
  play(track: LoopTrack): void {
    this.wantPlay = true;
    if (this.wanted?.id !== track.id) this.failed = false;
    this.wanted = track;
    if (this.current?.track.id === track.id) {
      this.cancelLoad();
      this.emit();
      return;
    }
    if (this.fading?.track.id === track.id) {
      this.cancelLoad();
      this.revive();
      this.emit();
      return;
    }
    if (this.ready?.track.id === track.id) {
      const { loaded } = this.ready;
      this.ready = null;
      this.begin(track, loaded);
      this.emit();
      return;
    }
    if (this.loading?.track.id !== track.id) {
      this.cancelLoad();
      this.dropReady();
      this.load(track);
    }
    this.emit();
  }

  /** Fades out and remembers the place; `resume` (or `play` with the same track) carries on from there. */
  pause(seconds = 0.6): void {
    this.wantPlay = false;
    if (this.current) {
      this.places.set(this.current.track.id, this.current.voice.position());
      this.fadeOut(this.current, seconds);
      this.current = null;
    }
    this.emit();
  }

  resume(): void {
    if (this.wanted) this.play(this.wanted);
  }

  /** Stops and forgets the track. */
  stop(seconds = 0.8): void {
    this.pause(seconds);
    this.cancelLoad();
    this.dropReady();
    this.wanted = null;
    this.places.clear();
    this.emit();
  }

  getState(): PlayerState {
    return this.state;
  }

  /** How many voices are sounding (playing or fading out): never more than two. */
  get voices(): number {
    return (this.current ? 1 : 0) + (this.fading ? 1 : 0);
  }

  private load(track: LoopTrack) {
    const abort = new AbortController();
    this.loading = { track, abort };
    this.output.load(track, abort.signal).then(
      (loaded) => this.loaded(track, abort, loaded),
      () => this.loaded(track, abort, null),
    );
  }

  private loaded(track: LoopTrack, abort: AbortController, loaded: Loaded | null) {
    if (this.loading?.abort !== abort) {
      loaded?.dispose(); // superseded or cancelled: never starts
      return;
    }
    this.loading = null;
    if (!loaded) {
      this.failed = true;
    } else if (this.wantPlay) {
      this.begin(track, loaded);
    } else {
      this.ready = { track, loaded };
    }
    this.emit();
  }

  private cancelLoad() {
    this.loading?.abort.abort();
    this.loading = null;
  }

  private dropReady() {
    this.ready?.loaded.dispose();
    this.ready = null;
  }

  /** Starts a loaded track over the one playing (which fades out). */
  private begin(track: LoopTrack, loaded: Loaded) {
    const from = this.current;
    if (from) {
      this.places.set(from.track.id, from.voice.position());
      this.fadeOut(from, CROSSFADE);
    }
    const offset = this.places.get(track.id) ?? 0;
    this.places.delete(track.id);
    const voice = loaded.start(track.duration > 0 ? offset % track.duration : 0);
    voice.fade(track.gain, from ? CROSSFADE : FADE_IN);
    this.current = { track, voice };
  }

  /** Fades a voice out and stops it; a voice already fading out stops at once, so at most two ever sound. */
  private fadeOut(s: Sounding, seconds: number) {
    if (this.fading) {
      this.fading.cancel();
      this.fading.voice.stop();
    }
    s.voice.fade(0, seconds);
    const fading = { ...s, cancel: () => {} };
    fading.cancel = this.output.later(() => {
      if (this.fading !== fading) return;
      this.fading = null;
      fading.voice.stop();
      this.emit();
    }, seconds * 1000 + 50);
    this.fading = fading;
  }

  /** The track fading out was asked for again: it comes back from where it is, and the one playing fades out. */
  private revive() {
    const back = this.fading!;
    back.cancel();
    this.fading = null;
    const from = this.current;
    if (from) {
      this.places.set(from.track.id, from.voice.position());
      this.fadeOut(from, CROSSFADE);
    }
    back.voice.fade(back.track.gain, from ? CROSSFADE : FADE_IN);
    this.current = { track: back.track, voice: back.voice };
    this.places.delete(back.track.id);
  }

  private emit() {
    const next: PlayerState = {
      track: this.wanted,
      playing: this.wantPlay && !!this.current && this.current.track.id === this.wanted?.id,
      audible: this.wantPlay && !!this.current,
      loading: !!this.loading,
      failed: this.failed,
    };
    const s = this.state;
    // The same track asked for again (a new object with the same id) is no change.
    const same = (k: keyof PlayerState) => (k === 'track' ? s.track?.id === next.track?.id : s[k] === next[k]);
    if ((Object.keys(next) as (keyof PlayerState)[]).every(same)) return;
    this.state = next;
    this.onChange(next);
  }
}

/**
 * Where to loop a decoded track: the whole buffer if the decoder took the encoder's silence out (it is then exactly
 * the audio's length), otherwise the audio inside it, from `lead`. Seconds.
 */
export function loopPoints(decoded: number, track: Pick<LoopTrack, 'duration' | 'lead'>): [number, number] {
  const { duration, lead } = track;
  if (!(duration > 0) || Math.abs(decoded - duration) < 0.005) return [0, decoded];
  if (decoded >= lead + duration - 0.005) return [lead, lead + duration];
  return [0, decoded];
}
