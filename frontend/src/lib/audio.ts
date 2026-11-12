/**
 * Audio engine: one Web Audio graph for the sound effects and the background music, the visitor's volume settings,
 * the music player and the previews used by the taste test. What each event sounds like is in soundPacks.ts, and
 * sounds.ts wires everything to the site.
 *
 *   limiter ← master ─┬─ sfx bus ──── synthesized sounds and Deadlock stingers
 *                     ├─ music bus ── duck ─┬─ deck A  (two <audio> elements, so tracks cross-fade)
 *                     │                     └─ deck B
 *                     └─ preview bus ──────── demos and music previews (play even when sound is off: asked for)
 *
 * Browsers only allow sound after the visitor clicks or presses a key, so the graph is built on the first one.
 * Effects are synthesized (no files, no latency); music streams from /music (see scripts/wiki_music.py).
 */
import { createRoot, createSignal } from 'solid-js';

export interface AudioSettings {
  /** Everything off: the speaker button in the header, or the M key. */
  muted: boolean;
  sfxOn: boolean;
  /** 0..1 as on the slider; the gain is its square, which sounds even across the range. */
  sfxVolume: number;
  musicOn: boolean;
  musicVolume: number;
}

/** Music starts on, quietly, so people hear it and can judge it; the speaker button and M mute everything. */
export const AUDIO_DEFAULTS: AudioSettings = { muted: false, sfxOn: true, sfxVolume: 0.7, musicOn: true, musicVolume: 0.5 };

const SETTINGS_KEY = 'naebka.audio';
const CROSSFADE = 2.5;

function loadSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...AUDIO_DEFAULTS, ...(JSON.parse(raw) as Partial<AudioSettings>) } : { ...AUDIO_DEFAULTS };
  } catch {
    return { ...AUDIO_DEFAULTS };
  }
}

const NOTES: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** 'A4' → 440 Hz; `shift` moves it by semitones. */
export function hz(note: string, shift = 0): number {
  const m = /^([A-G]#?)(\d)$/.exec(note);
  if (!m) throw new Error(`Bad note ${note}`);
  const midi = (Number(m[2]) + 1) * 12 + NOTES[m[1]!]! + shift;
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface ToneOptions {
  /** Frequency in Hz, gliding to `to` if given. */
  f: number;
  to?: number;
  type?: OscillatorType;
  /** Start, in seconds after the sound starts. */
  at?: number;
  dur: number;
  gain?: number;
  attack?: number;
  /** Low-pass filter cutoff (Hz), sweeping to `lpTo`. */
  lp?: number;
  lpTo?: number;
  /** Vibrato depth in Hz. */
  vib?: number;
}

export interface NoiseOptions {
  at?: number;
  dur: number;
  gain?: number;
  /** Band-pass centre (Hz), sweeping to `to`; or a plain high- or low-pass. */
  band?: number;
  to?: number;
  q?: number;
  hp?: number;
  lp?: number;
  attack?: number;
}

/** What a sound recipe draws with. Times are relative to the start of the sound. */
export interface Voice {
  tone(o: ToneOptions): void;
  noise(o: NoiseOptions): void;
}

export interface MusicTrack {
  id: string;
  url: string;
  /** How many times the file loops before the next track. */
  repeat: number;
  /** Playback gain that evens out the tracks' loudness (musicCatalog.ts). */
  gain: number;
}

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode | null;
  track: MusicTrack | null;
  loops: number;
  last: number;
}

/** A tiny silent WAV: playing it inside a click "unlocks" an <audio> element on iOS for later. */
const SILENCE = `data:audio/wav;base64,${btoa(
  String.fromCharCode(
    0x52, 0x49, 0x46, 0x46, 37, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
    0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0, 0x64, 0x61, 0x74, 0x61, 1, 0, 0, 0, 128,
  ),
)}`;

function newElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'none';
  return el;
}

export const audio = createRoot(() => {
  const [settings, setSettingsSignal] = createSignal<AudioSettings>(loadSettings());
  const [unlocked, setUnlocked] = createSignal(false);
  const [current, setCurrent] = createSignal<{ list: MusicTrack[]; index: number } | null>(null);
  const [playing, setPlaying] = createSignal(false);
  const [previewing, setPreviewing] = createSignal<string | null>(null);

  let ctx: AudioContext | null = null;
  let master!: GainNode;
  let sfxBus!: GainNode;
  let musicBus!: GainNode;
  let duck!: GainNode;
  let previewBus!: GainNode;
  let noiseBuffer!: AudioBuffer;

  const decks: [Deck, Deck] = [
    { el: newElement(), gain: null, track: null, loops: 0, last: 0 },
    { el: newElement(), gain: null, track: null, loops: 0, last: 0 },
  ];
  let active = 0;
  let advancing = false;
  // What the music should be doing, so a track that is still starting when pause() is called doesn't start anyway.
  let intent: 'play' | 'pause' = 'pause';
  const previewEl = newElement();
  let previewGain: GainNode | null = null;
  let previewTimer: number | undefined;

  const gainFor = (on: boolean, volume: number) => (on && !settings().muted ? volume * volume : 0);

  const applyGains = () => {
    if (!ctx) return;
    const s = settings();
    const t = ctx.currentTime;
    sfxBus.gain.setTargetAtTime(gainFor(s.sfxOn, s.sfxVolume), t, 0.03);
    musicBus.gain.setTargetAtTime(gainFor(s.musicOn, s.musicVolume), t, 0.08);
  };

  const build = () => {
    const c = new AudioContext({ latencyHint: 'interactive' });
    // A gentle limiter, so a stinger on top of music on top of clicks never clips.
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(c.destination);
    master = c.createGain();
    master.connect(limiter);
    sfxBus = c.createGain();
    sfxBus.connect(master);
    musicBus = c.createGain();
    musicBus.connect(master);
    duck = c.createGain();
    duck.connect(musicBus);
    previewBus = c.createGain();
    previewBus.connect(master);

    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    for (const d of decks) {
      d.gain = c.createGain();
      d.gain.gain.value = 0;
      c.createMediaElementSource(d.el).connect(d.gain).connect(duck);
    }
    previewGain = c.createGain();
    previewGain.gain.value = 0;
    c.createMediaElementSource(previewEl).connect(previewGain).connect(previewBus);
    ctx = c;
    applyGains();
  };

  const prime = (el: HTMLAudioElement) => {
    if (el.src) return;
    el.src = SILENCE;
    el.play().then(() => el.pause(), () => {});
  };

  // Every click or key press tries until the context runs: iOS only counts some events (touchend) as a gesture.
  const unlock = () => {
    try {
      if (!ctx) build();
    } catch {
      return; // no Web Audio: the site stays silent
    }
    prime(decks[0].el);
    prime(decks[1].el);
    prime(previewEl);
    // Sounds asked for now are scheduled and play the moment the context runs, so the first click isn't lost.
    setUnlocked(true);
    const done = () => {
      if (ctx?.state !== 'running') return;
      for (const type of ['pointerdown', 'keydown', 'touchend'] as const) document.removeEventListener(type, unlock, true);
    };
    if (ctx!.state === 'running') done();
    else ctx!.resume().then(done, () => {});
  };
  if (typeof document !== 'undefined') {
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) document.addEventListener(type, unlock, true);
  }

  const setSettings = (patch: Partial<AudioSettings>) => {
    const next = { ...settings(), ...patch };
    next.sfxVolume = Math.min(1, Math.max(0, next.sfxVolume));
    next.musicVolume = Math.min(1, Math.max(0, next.musicVolume));
    setSettingsSignal(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the settings last for this page only
    }
    applyGains();
  };

  // ---- Synthesized sounds ----

  const envelope = (p: AudioParam, t: number, end: number, peak: number, attack: number) => {
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.min(attack, (end - t) / 2));
    p.exponentialRampToValueAtTime(0.0001, end);
  };

  const voiceAt = (c: BaseAudioContext, out: AudioNode, t0: number): Voice => ({
    tone(o) {
      const t = t0 + (o.at ?? 0);
      const end = t + o.dur;
      const osc = c.createOscillator();
      osc.type = o.type ?? 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, end);
      let node: AudioNode = osc;
      if (o.lp) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(o.lp, t);
        if (o.lpTo) f.frequency.exponentialRampToValueAtTime(o.lpTo, end);
        node.connect(f);
        node = f;
      }
      if (o.vib) {
        const lfo = c.createOscillator();
        const depth = c.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = o.vib;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(end + 0.05);
      }
      const g = c.createGain();
      envelope(g.gain, t, end, o.gain ?? 0.2, o.attack ?? 0.004);
      node.connect(g).connect(out);
      osc.start(t);
      osc.stop(end + 0.05);
    },
    noise(o) {
      const t = t0 + (o.at ?? 0);
      const end = t + o.dur;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      let node: AudioNode = src;
      const filter = (type: BiquadFilterType, f: number, to?: number, q?: number) => {
        const b = c.createBiquadFilter();
        b.type = type;
        b.frequency.setValueAtTime(f, t);
        if (to) b.frequency.exponentialRampToValueAtTime(to, end);
        if (q) b.Q.value = q;
        node.connect(b);
        node = b;
      };
      if (o.band) filter('bandpass', o.band, o.to, o.q ?? 1);
      if (o.hp) filter('highpass', o.hp);
      if (o.lp) filter('lowpass', o.lp);
      const g = c.createGain();
      envelope(g.gain, t, end, o.gain ?? 0.2, o.attack ?? 0.002);
      node.connect(g).connect(out);
      src.start(t, Math.random() * 0.8);
      src.stop(end + 0.05);
    },
  });

  /**
   * Plays a synthesized sound at `gain` (its pack's trim). `demo` sounds go to the preview bus and play even when
   * effects are off.
   */
  const synth = (recipe: (v: Voice) => void, demo = false, delay = 0, gain = 1) => {
    if (!ctx || ctx.state === 'closed') return false;
    if (!demo && gainFor(settings().sfxOn, settings().sfxVolume) === 0) return false;
    if (demo) previewBus.gain.setTargetAtTime(Math.max(settings().sfxVolume, 0.4) ** 2, ctx.currentTime, 0.01);
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(demo ? previewBus : sfxBus);
    recipe(voiceAt(ctx, out, ctx.currentTime + 0.005 + delay));
    return true;
  };

  // ---- Stingers (short music files) ----

  const decoded = new Map<string, AudioBuffer>();
  const loading = new Map<string, Promise<void>>();
  let stinger: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  let duckUntil = 0;

  const preload = (url: string) => {
    if (!ctx || decoded.has(url) || loading.has(url)) return;
    const c = ctx;
    loading.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => c.decodeAudioData(b))
        .then((buf) => void decoded.set(url, buf))
        .catch(() => {}),
    );
  };

  const duckMusic = (seconds: number, level: number) => {
    if (!ctx) return;
    const t = ctx.currentTime;
    duckUntil = Math.max(duckUntil, t + seconds);
    duck.gain.cancelScheduledValues(t);
    duck.gain.setTargetAtTime(level, t, 0.06);
    duck.gain.setTargetAtTime(1, duckUntil, 0.5);
  };

  /**
   * Plays a stinger if it is already loaded (and starts loading it if not), so a sound never arrives late; the
   * caller plays a synthesized stand-in when this returns false. One stinger at a time; the music ducks under it.
   */
  const playStinger = (url: string, opts: { maxSeconds?: number; gain?: number; demo?: boolean } = {}) => {
    if (!ctx || ctx.state === 'closed') return false;
    const buf = decoded.get(url);
    if (!buf) {
      preload(url);
      return false;
    }
    const s = settings();
    if (!opts.demo && gainFor(s.sfxOn, s.sfxVolume) === 0) return true;
    const t = ctx.currentTime;
    if (stinger) {
      stinger.gain.gain.setTargetAtTime(0.0001, t, 0.04);
      stinger.src.stop(t + 0.2);
    }
    const len = Math.min(buf.duration, opts.maxSeconds ?? Infinity);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const peak = opts.gain ?? 0.55;
    g.gain.setValueAtTime(peak, t);
    if (len < buf.duration) {
      g.gain.setValueAtTime(peak, t + Math.max(0, len - 1.2));
      g.gain.linearRampToValueAtTime(0.0001, t + len);
    }
    if (opts.demo) previewBus.gain.setTargetAtTime(Math.max(s.sfxVolume, 0.4) ** 2, t, 0.01);
    src.connect(g).connect(opts.demo ? previewBus : sfxBus);
    src.start(t);
    src.stop(t + len + 0.05);
    stinger = { src, gain: g };
    src.onended = () => {
      if (stinger?.src === src) stinger = null;
    };
    duckMusic(len, 0.3);
    return true;
  };

  // ---- Music ----

  const fade = (d: Deck, to: number, seconds: number) => {
    if (!ctx || !d.gain) return;
    const t = ctx.currentTime;
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(to, t + seconds);
  };

  const start = (list: MusicTrack[], index: number, seconds: number) => {
    const track = list[index];
    if (!track) return;
    const from = decks[active]!;
    active = 1 - active;
    const to = decks[active]!;
    advancing = false;
    to.track = track;
    to.loops = 0;
    to.last = 0;
    to.el.loop = true;
    to.el.preload = 'auto';
    to.el.src = track.url;
    if (to.gain && ctx) to.gain.gain.setValueAtTime(0, ctx.currentTime);
    setCurrent({ list, index });
    intent = 'play';
    to.el.play().then(
      () => {
        if (decks[active] !== to) return;
        if (intent === 'pause') {
          to.el.pause();
          return;
        }
        setPlaying(true);
        fade(to, track.gain, seconds);
      },
      () => {
        if (decks[active] === to) setPlaying(false);
      },
    );
    if (from.track) {
      fade(from, 0, seconds);
      const old = from.track;
      window.setTimeout(() => {
        if (from.track === old && decks[active] !== from) from.el.pause();
      }, seconds * 1000 + 100);
    }
  };

  const advance = () => {
    const c = current();
    if (!c || c.list.length < 2) return;
    advancing = true;
    start(c.list, (c.index + 1) % c.list.length, CROSSFADE);
  };

  for (const d of decks) {
    d.el.addEventListener('timeupdate', () => {
      if (decks[active] !== d || !d.track) return;
      const t = d.el.currentTime;
      if (t + 1 < d.last) d.loops++;
      d.last = t;
      if (!advancing && d.loops >= d.track.repeat - 1 && d.el.duration - t <= CROSSFADE + 0.3) advance();
    });
    d.el.addEventListener('error', () => {
      if (decks[active] !== d || !d.track || d.el.src === SILENCE) return;
      const c = current();
      // A missing file: try the next one, or stop if this was the only one.
      if (c && c.list.length > 1) window.setTimeout(advance, 500);
      else setPlaying(false);
    });
  }

  const music = {
    current,
    playing,
    /** Plays a list of tracks from `index`, cross-fading from whatever plays now. */
    play(list: MusicTrack[], index = 0) {
      if (!ctx) return;
      start(list, index, playing() ? CROSSFADE : 1.5);
    },
    skip: advance,
    /** Fades out and pauses; `resume` picks up where it was. */
    pause(seconds = 0.6) {
      intent = 'pause';
      const d = decks[active]!;
      if (!d.track) return;
      if (!playing()) {
        d.el.pause();
        return;
      }
      setPlaying(false);
      fade(d, 0, seconds);
      window.setTimeout(() => {
        if (intent === 'pause') d.el.pause();
      }, seconds * 1000 + 50);
    },
    resume() {
      const d = decks[active]!;
      if (!d.track || playing() || !ctx) return;
      intent = 'play';
      d.el.play().then(
        () => {
          if (intent === 'pause' || decks[active] !== d) {
            d.el.pause();
            return;
          }
          setPlaying(true);
          fade(d, d.track?.gain ?? 1, 1.5);
        },
        () => {},
      );
    },
    stop(seconds = 0.8) {
      music.pause(seconds);
      setCurrent(null);
      for (const d of decks) d.track = null;
    },
  };

  // ---- Previews (the taste test and the Customize panel) ----

  const stopPreview = () => {
    window.clearTimeout(previewTimer);
    if (!previewing()) return;
    setPreviewing(null);
    if (ctx && previewGain) {
      const t = ctx.currentTime;
      previewGain.gain.cancelScheduledValues(t);
      previewGain.gain.setTargetAtTime(0.0001, t, 0.08);
      duck.gain.cancelScheduledValues(t);
      duck.gain.setTargetAtTime(1, t + 0.2, 0.4);
    }
    window.setTimeout(() => !previewing() && previewEl.pause(), 400);
  };

  /** Plays `seconds` of a track from `at` at `gain`, with the music faded away underneath. */
  const previewMusic = (key: string, url: string, at: number, seconds = 12, gain = 1) => {
    if (!ctx || !previewGain) return;
    window.clearTimeout(previewTimer);
    setPreviewing(key);
    const t = ctx.currentTime;
    duck.gain.cancelScheduledValues(t);
    duck.gain.setTargetAtTime(0, t, 0.1);
    previewBus.gain.setTargetAtTime(Math.max(settings().musicVolume, 0.45) ** 2, t, 0.01);
    previewGain.gain.cancelScheduledValues(t);
    previewGain.gain.setValueAtTime(0.0001, t);
    const begin = () => {
      previewEl.currentTime = at;
      previewEl.play().then(
        () => {
          if (!ctx || !previewGain || previewing() !== key) return;
          const now = ctx.currentTime;
          previewGain.gain.setTargetAtTime(gain, now, 0.15);
          previewGain.gain.setTargetAtTime(0.0001, now + seconds - 1.2, 0.35);
          previewTimer = window.setTimeout(stopPreview, seconds * 1000);
        },
        () => setPreviewing(null),
      );
    };
    const absolute = new URL(url, location.href).href;
    if (previewEl.src !== absolute) {
      previewEl.preload = 'auto';
      previewEl.src = url;
      previewEl.addEventListener('loadedmetadata', begin, { once: true });
      previewEl.load();
    } else begin();
  };

  return {
    settings,
    setSettings,
    /** True once the browser lets the page make sound (after the first click or key press). */
    unlocked,
    synth,
    playStinger,
    preload,
    music,
    preview: { music: previewMusic, stop: stopPreview, playing: previewing },
    /**
     * Renders a recipe offline: its peak and its loudness (dB RMS of its loudest 400 ms), for balancing the packs
     * against each other and against the stingers (in the browser console of `vp dev`: import this module).
     */
    async measure(recipe: (v: Voice) => void, seconds = 2): Promise<{ peak: number; loudness: number }> {
      const rate = 44100;
      const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
      if (!noiseBuffer) {
        noiseBuffer = off.createBuffer(1, rate, rate);
        const d = noiseBuffer.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      recipe(voiceAt(off, off.destination, 0));
      const out = (await off.startRendering()).getChannelData(0);
      let peak = 0;
      for (const x of out) peak = Math.max(peak, Math.abs(x));
      const win = Math.round(rate * 0.4);
      let sum = 0;
      let loudest = 0;
      for (let i = 0; i < out.length; i++) {
        sum += out[i]! * out[i]!;
        if (i >= win) sum -= out[i - win]! * out[i - win]!;
        if (i >= win - 1) loudest = Math.max(loudest, sum / win);
      }
      return { peak: 20 * Math.log10(peak + 1e-9), loudness: 10 * Math.log10(loudest + 1e-12) };
    },
  };
});
