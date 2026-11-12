/**
 * Sound controls: the speaker button in the header (mutes everything; so does the M key) and the Sound tab of the
 * Customize panel (music station, sound pack, on/off and volume for each).
 */
import { For, Show, type JSX } from 'solid-js';
import { audio } from '../lib/audio';
import { ab, experiment } from '../lib/experiments';
import { musicFiles, stationAvailable, STATIONS, trackTitle } from '../lib/musicCatalog';
import { sounds } from '../lib/sounds';
import { artOf } from './variantArt';

/** Everything silent: muted, or both music and effects switched off. */
const silent = () => {
  const s = audio.settings();
  return s.muted || (!s.musicOn && !s.sfxOn);
};

export function SoundButton() {
  const toggle = () => {
    if (silent()) {
      const s = audio.settings();
      if (!s.musicOn && !s.sfxOn) audio.setSettings({ musicOn: true, sfxOn: true });
      sounds.setMuted(false);
      sounds.play('toggle');
    } else sounds.setMuted(true);
  };
  return (
    <button
      data-sound="none"
      onClick={toggle}
      aria-pressed={silent()}
      aria-label={silent() ? 'Turn sound on (M)' : 'Mute sound and music (M)'}
      title={silent() ? 'Turn sound on (M)' : 'Mute sound and music (M)'}
      class="grid size-9 shrink-0 place-items-center rounded-lg text-ink-200 ring-1 ring-ink-700 transition-colors hover:bg-ink-850 hover:text-gold-300"
    >
      <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" fill-opacity="0.15" />
        <Show
          when={!silent()}
          fallback={
            <>
              <path d="m16 9 5 6" />
              <path d="m21 9-5 6" />
            </>
          }
        >
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </Show>
      </svg>
    </button>
  );
}

function Switch(props: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
      class={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${props.on ? 'bg-gold-500' : 'bg-ink-600'}`}
    >
      <span class={`absolute top-0.5 size-4 rounded-full bg-ink-100 shadow transition-all ${props.on ? 'left-[1.125rem]' : 'left-0.5'}`} />
    </button>
  );
}

function Volume(props: { value: number; onInput: (v: number) => void; disabled: boolean; label: string; onRelease?: () => void }) {
  return (
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      onChange={() => props.onRelease?.()}
      class="h-1.5 w-full cursor-pointer accent-[var(--color-gold-500)] disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function OptionTile(props: { experiment: string; id: string; selected: boolean; onPick: () => void; badge?: JSX.Element; disabled?: boolean }) {
  const art = () => artOf(props.experiment, props.id);
  const label = () => experiment(props.experiment).variants.find((v) => v.id === props.id)?.label ?? props.id;
  return (
    <button
      role="radio"
      aria-checked={props.selected}
      data-sound="none"
      disabled={props.disabled}
      onClick={props.onPick}
      class={`relative flex items-center gap-2.5 rounded-xl bg-ink-850 p-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
        props.selected ? `ring-2 ${art()?.ring ?? 'ring-gold-400'}` : 'opacity-80 ring-1 ring-ink-700 hover:opacity-100'
      }`}
    >
      <span class={`grid size-10 shrink-0 place-items-center rounded-lg ${art()?.bg ?? 'bg-ink-800'} [&_img]:size-7 [&_span]:text-xl`}>{art()?.art()}</span>
      <span class="min-w-0 leading-tight">
        <span class="block truncate text-sm font-semibold text-ink-100">{label()}</span>
        <span class="line-clamp-2 block text-[11px] leading-tight text-ink-400">{art()?.note}</span>
      </span>
      {props.badge}
    </button>
  );
}

/** Animated bars for "this one is playing". */
function Bars() {
  return (
    <span class="absolute right-2 top-2 flex h-3 items-end gap-px" aria-hidden="true">
      <For each={[0, 1, 2]}>{(i) => <span class="w-0.5 animate-pulse-soft rounded-sm bg-gold-300" style={{ height: `${50 + i * 25}%`, 'animation-delay': `${i * 0.2}s` }} />}</For>
    </span>
  );
}

export function SoundSettings() {
  const s = audio.settings;
  const music = experiment('music');
  const packs = experiment('sfx_pack');
  const noMusic = () => musicFiles.ready() && !Object.keys(STATIONS).some(stationAvailable);

  const pickStation = (id: string) => {
    ab.choose('music', id);
    if (!s().musicOn || s().muted) sounds.setMusicOn(true);
  };
  const pickPack = (id: string) => {
    ab.choose('sfx_pack', id);
    if (!s().sfxOn || s().muted) sounds.setSfxOn(true);
    sounds.previewPack(id);
  };

  return (
    <div class="flex flex-col gap-4">
      <Show when={s().muted}>
        <div class="flex items-center justify-between gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          Everything is muted.
          <button class="font-semibold underline-offset-2 hover:underline" onClick={() => sounds.setMuted(false)}>
            Unmute
          </button>
        </div>
      </Show>

      <section class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-ink-400">Music</h4>
          <Switch on={s().musicOn} onChange={sounds.setMusicOn} label="Music" />
        </div>
        <Volume value={s().musicVolume} onInput={sounds.setMusicVolume} disabled={!s().musicOn || s().muted} label="Music volume" />
        <Show
          when={!noMusic()}
          fallback={<p class="text-xs text-ink-400">The music files aren’t installed on this server (frontend/scripts/wiki_music.py).</p>}
        >
          <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Music station">
            <For each={music.variants}>
              {(v) => (
                <OptionTile
                  experiment="music"
                  id={v.id}
                  selected={ab.committed('music') === v.id}
                  disabled={!stationAvailable(v.id)}
                  onPick={() => pickStation(v.id)}
                  badge={<Show when={ab.committed('music') === v.id && audio.music.playing()}><Bars /></Show>}
                />
              )}
            </For>
          </div>
          <div class="flex min-h-7 items-center justify-between gap-2 text-xs text-ink-400">
            <Show
              when={sounds.nowPlaying()}
              fallback={<span>{audio.unlocked() || !s().musicOn ? (s().musicOn && !s().muted ? 'Starting…' : 'Music is off.') : 'Music starts after your first click.'}</span>}
            >
              {(slug) => (
                <>
                  <span class="truncate">
                    ♪ <span class="text-ink-200">{trackTitle(slug())}</span> · Deadlock OST
                  </span>
                  <Show when={(STATIONS[ab.committed('music')]?.tracks.length ?? 0) > 1}>
                    <button class="shrink-0 rounded-md px-2 py-1 font-semibold text-ink-300 ring-1 ring-ink-700 hover:bg-ink-800 hover:text-ink-100" onClick={sounds.skip}>
                      Next ⏭
                    </button>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
      </section>

      <section class="flex flex-col gap-2 border-t border-ink-700 pt-3">
        <div class="flex items-center justify-between gap-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-ink-400">Sound effects</h4>
          <Switch on={s().sfxOn} onChange={sounds.setSfxOn} label="Sound effects" />
        </div>
        <Volume
          value={s().sfxVolume}
          onInput={sounds.setSfxVolume}
          onRelease={() => sounds.play('click')}
          disabled={!s().sfxOn || s().muted}
          label="Sound effects volume"
        />
        <div class="grid grid-cols-1 gap-2" role="radiogroup" aria-label="Sound pack">
          <For each={packs.variants}>
            {(v) => <OptionTile experiment="sfx_pack" id={v.id} selected={ab.committed('sfx_pack') === v.id} onPick={() => pickPack(v.id)} />}
          </For>
        </div>
        <p class="text-[11px] text-ink-500">Tap a pack to hear it. Press M anywhere to mute.</p>
      </section>
    </div>
  );
}
