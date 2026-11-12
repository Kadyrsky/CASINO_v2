/**
 * Sound on the site: every button clicks in the visitor's sound pack, game events play theirs, and their music
 * station runs in the background. It also tells the A/B experiments when people actually hear a pack or a station,
 * and when they turn music or sounds off (the main signal for the audio experiments).
 *
 * Buttons need nothing: a click on any button, link, tab or option plays a sound picked from what it is. Override
 * with data-sound="bet" (any SoundEvent) or silence it with data-sound="none" (on the element or a container).
 */
import { createEffect, createRoot, createSignal, onCleanup, untrack } from 'solid-js';
import { audio } from './audio';
import { auth } from './auth';
import { ab } from './experiments';
import { musicFiles, STATIONS, stationTracks } from './musicCatalog';
import { LEVELS, PACKS, type SoundEvent, type SoundPack } from './soundPacks';
import { hub } from './ws';

const CONTROLS =
  'button, a[href], summary, select, input[type="checkbox"], input[type="radio"], [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="switch"], [role="checkbox"]';
const UI_SOUNDS = new Set<SoundEvent>(['click', 'tap', 'select', 'toggle', 'open', 'close']);
/** Stingers the Deadlock pack uses most, fetched in the background once sound is allowed (about 2 MB). */
const DEADLOCK_PRELOAD = ['first-blood', 'ks-02', 'ks-03', 'ks-04', 'rift-secured', 'urn-arrived', 'rift-announce', 'victory', 'rejuv-won', 'rejuv-lost'];

function defaultSound(el: Element): SoundEvent {
  if (el.classList.contains('btn-dl')) return 'click';
  const role = el.getAttribute('role');
  const type = el instanceof HTMLInputElement ? el.type : '';
  if (role === 'radio' || type === 'radio') return 'select';
  if (role === 'switch' || role === 'checkbox' || type === 'checkbox') return 'toggle';
  return 'tap';
}

export const sounds = createRoot(() => {
  const [hidden, setHidden] = createSignal(typeof document !== 'undefined' && document.hidden);
  let lastEvent = 0;
  let station: string | null = null;

  const pack = (): SoundPack => PACKS[ab.variant('sfx_pack')] ?? PACKS.deadlock!;
  const audible = () => {
    const s = audio.settings();
    return audio.unlocked() && s.sfxOn && !s.muted && s.sfxVolume > 0;
  };

  const playFrom = (p: SoundPack, event: SoundEvent, n: number, demo: boolean, delay = 0) => {
    const slug = p.stingers?.[event]?.(n);
    if (slug && musicFiles.has(slug)) {
      if (delay > 0) {
        window.setTimeout(() => playFrom(p, event, n, demo), delay * 1000);
        return;
      }
      // A stinger is as loud as the event it stands for (LEVELS), like the other packs' synthesized versions.
      const gain = 10 ** (Math.min(12, Math.max(-36, LEVELS[event] - musicFiles.loudness(slug))) / 20);
      if (audio.playStinger(musicFiles.url(slug), { maxSeconds: p.stingerMax?.[event], gain, demo })) return;
    }
    audio.synth((v) => p.sounds[event](v, n), demo, delay, 10 ** ((p.trim?.[event] ?? 0) / 20));
  };

  /**
   * Plays an event in the visitor's pack. `n`: the reel, the streak length, the Patron. `quietFor`: skip it if
   * another game sound played in the last that-many ms (so a toast doesn't stack on the win it announces).
   */
  const play = (event: SoundEvent, n = 0, opts: { delay?: number; quietFor?: number } = {}) => {
    if (opts.quietFor && performance.now() - lastEvent < opts.quietFor) return;
    if (!UI_SOUNDS.has(event)) lastEvent = performance.now();
    if (!audible()) return;
    ab.expose('sfx_pack');
    playFrom(pack(), event, n, false, opts.delay);
  };

  // ---- Every control clicks ----

  const soundOf = (target: EventTarget | null): SoundEvent | null => {
    if (!(target instanceof Element)) return null;
    const control = target.closest(CONTROLS);
    if (!control || control.matches(':disabled, [aria-disabled="true"]')) return null;
    const tag = control.closest('[data-sound]')?.getAttribute('data-sound');
    if (tag === 'none') return null;
    return tag && tag in LEVELS ? (tag as SoundEvent) : defaultSound(control);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        const event = soundOf(e.target);
        if (event) play(event);
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        const el = e.target as Element | null;
        if (e.repeat || !el || el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]')) return;
        if (e.key === 'Enter' || (e.key === ' ' && !el.matches('a'))) {
          const event = soundOf(el);
          if (event) play(event);
        }
        if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && !el.closest('select')) toggleMute();
      },
      true,
    );
    document.addEventListener('visibilitychange', () => setHidden(document.hidden));
  }

  // ---- Settings, with the reactions the experiments count ----

  const setMuted = (muted: boolean) => {
    const s = audio.settings();
    if (muted && !s.muted) {
      if (s.musicOn && audio.music.playing()) ab.track('music_off');
      if (s.sfxOn) ab.track('sounds_off');
    }
    audio.setSettings({ muted });
  };
  const toggleMute = () => setMuted(!audio.settings().muted);

  const setMusicOn = (on: boolean) => {
    if (!on && audio.music.playing()) ab.track('music_off');
    audio.setSettings(on ? { musicOn: true, muted: false, musicVolume: Math.max(audio.settings().musicVolume, 0.1) } : { musicOn: false });
  };
  const setSfxOn = (on: boolean) => {
    if (!on && audible()) ab.track('sounds_off');
    audio.setSettings(on ? { sfxOn: true, muted: false, sfxVolume: Math.max(audio.settings().sfxVolume, 0.1) } : { sfxOn: false });
  };
  const setMusicVolume = (v: number) => {
    if (v === 0 && audio.music.playing()) ab.track('music_off');
    audio.setSettings({ musicVolume: v });
  };
  const setSfxVolume = (v: number) => {
    if (v === 0 && audible()) ab.track('sounds_off');
    audio.setSettings({ sfxVolume: v });
  };

  // ---- Music: play the visitor's station whenever sound is allowed, music is on and the tab is visible ----

  createEffect(() => {
    const s = audio.settings();
    const want = audio.unlocked() && s.musicOn && !s.muted && s.musicVolume > 0 && !hidden() && musicFiles.ready();
    const next = ab.variant('music');
    untrack(() => {
      if (!want) {
        audio.music.pause();
        return;
      }
      if (station === next && audio.music.current()) {
        audio.music.resume();
        return;
      }
      const list = stationTracks(next);
      if (!list.length) return;
      station = next;
      audio.music.play(list, 0);
    });
  });
  createEffect(() => {
    if (audio.music.playing()) ab.expose('music');
  });

  // The Deadlock pack's stingers, so the first big win already sounds like the game.
  createEffect(() => {
    if (!audio.unlocked() || !musicFiles.ready()) return;
    const slugs = ab.variant('sfx_pack') === 'deadlock' ? DEADLOCK_PRELOAD : ['first-blood'];
    window.setTimeout(() => slugs.filter(musicFiles.has).forEach((s) => audio.preload(musicFiles.url(s))), 1500);
  });

  // A live bet settling, wherever the player is on the site.
  createEffect(() => {
    const user = auth.user();
    if (!user) return;
    const off = hub.subscribe(`user:${user.id}`, (msg) => {
      if (msg.type !== 'BET_SETTLED') return;
      const status = (msg.data as { status?: string }).status;
      play(status === 'WON' ? 'betWon' : status === 'LOST' ? 'betLost' : 'notify');
    });
    onCleanup(off);
  });

  return {
    play,
    audible,
    setMuted,
    toggleMute,
    setMusicOn,
    setSfxOn,
    setMusicVolume,
    setSfxVolume,
    /** Skips to the next track of the station. */
    skip: () => audio.music.skip(),
    /** The track playing now (its slug), if any. */
    nowPlaying: () => {
      const c = audio.music.current();
      return audio.music.playing() && c ? (c.list[c.index]?.id ?? null) : null;
    },
    /** A few seconds of a station, over the music (the taste test and Customize). */
    previewStation: (id: string) => {
      const [slug, at] = STATIONS[id]?.preview ?? [];
      if (!slug || !musicFiles.has(slug)) return false;
      // Same length and same loudness for every station, so none wins by being louder.
      audio.preview.music(`music:${id}`, musicFiles.url(slug), at ?? 0, 12, musicFiles.musicGain(slug));
      return true;
    },
    /** A pack's demo sequence; plays even when effects are off, since it was asked for. */
    previewPack: (id: string) => {
      const p = PACKS[id];
      if (!p) return;
      audio.preview.stop();
      for (const [event, at] of p.demo) playFrom(p, event, 0, true, at);
    },
    stopPreview: () => audio.preview.stop(),
    /** Which station's preview is playing ('music:<id>'), if any. */
    previewing: audio.preview.playing,
  };
});
