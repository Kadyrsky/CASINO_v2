/**
 * The "Customize" button in the header: a drop-down where anyone can switch the A/B experiments they can see or hear
 * (theme and slot symbols under Look; music pack, its version and sound pack under Sound), with the page staying visible
 * underneath so they see the change straight away. A dot marks the button until it has been opened once; the
 * first-visit invitation to the taste test (TasteTest.tsx) points people here too.
 */
import { For, onCleanup, onMount, Show } from 'solid-js';
import { ab, EXPERIMENTS, variantLabel } from '../lib/experiments';
import { customize, feedbackPanel, tasteTest } from '../lib/panels';
import { sounds } from '../lib/sounds';
import { SoundSettings } from './SoundControls';
import { tasteTestAvailable } from './TasteTest';
import { artOf } from './variantArt';

function LookSettings() {
  const choose = (key: string, id: string) => {
    if (ab.committed(key) === id) return;
    ab.choose(key, id);
    // A theme has its own soft cue instead of the click (a new one cuts the last one off, so trying them all in a
    // row doesn't stack them).
    if (key === 'theme') sounds.theme(id);
  };
  return (
    <div class="flex flex-col gap-4">
      <For each={EXPERIMENTS.filter((e) => e.switchable && e.group === 'look')}>
        {(exp) => (
          <section>
            <h4 class="text-xs font-semibold uppercase tracking-wider text-ink-400">{exp.title}</h4>
            <div class={`mt-2 grid gap-2 ${exp.variants.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={exp.title}>
              <For each={exp.variants}>
                {(v) => {
                  const p = artOf(exp.key, v.id);
                  const selected = () => ab.variant(exp.key) === v.id;
                  return (
                    <button
                      role="radio"
                      aria-checked={selected()}
                      data-sound={exp.key === 'theme' ? 'none' : undefined}
                      onClick={() => choose(exp.key, v.id)}
                      class={`flex flex-col items-start gap-2 rounded-xl p-2.5 text-left transition-all ${
                        selected() ? `ring-2 ${p?.ring ?? 'ring-gold-400'}` : 'opacity-75 ring-1 ring-ink-700 hover:opacity-100'
                      } bg-ink-850`}
                    >
                      <span class={`grid h-12 w-full place-items-center rounded-lg ${p?.bg ?? 'bg-ink-800'}`}>{p?.art()}</span>
                      <span class="leading-tight">
                        <span class="block text-sm font-semibold text-ink-100">{v.label}</span>
                        <Show when={p?.note}>
                          <span class="block text-[11px] text-ink-400">{p!.note}</span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={ab.chosen(exp.key) && !ab.testing}>
              <button class="mt-1.5 text-xs text-ink-400 hover:text-gold-300" onClick={() => ab.choose(exp.key, ab.assigned(exp.key))}>
                Back to the one picked for me ({variantLabel(exp.key, ab.assigned(exp.key))})
              </button>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}

function CustomizePanel() {
  return (
    <div
      role="dialog"
      aria-label="Customize"
      class="fixed inset-x-4 top-16 z-50 max-h-[calc(100vh-5rem)] animate-pop overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900/97 p-4 shadow-2xl backdrop-blur sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[24rem]"
    >
      <div class="flex items-start justify-between gap-2">
        <div>
          <h3 class="font-semibold">Customize</h3>
          <p class="mt-0.5 text-xs text-ink-400">You got these at random. Switch any time — the page changes right away.</p>
        </div>
        <button class="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" onClick={customize.close} aria-label="Close">
          ✕
        </button>
      </div>
      <Show when={ab.testing}>
        <p class="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          Versions are forced by <code>?ab=</code> in this tab, so changes here won't show.
        </p>
      </Show>
      <div role="tablist" class="mt-3 grid grid-cols-2 rounded-lg bg-ink-850 p-1 ring-1 ring-ink-700">
        <For each={[{ id: 'look', label: 'Look' }, { id: 'sound', label: 'Sound' }] as const}>
          {(t) => (
            <button
              role="tab"
              aria-selected={customize.tab() === t.id}
              class={`dl-type rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${customize.tab() === t.id ? 'bg-ink-700 text-ink-100 shadow' : 'text-ink-400 hover:text-ink-200'}`}
              onClick={() => customize.setTab(t.id)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>
      <div class="mt-4">
        <Show when={customize.tab() === 'sound'} fallback={<LookSettings />}>
          <SoundSettings />
        </Show>
      </div>
      <div class="mt-4 flex flex-col gap-2 border-t border-ink-700 pt-3 text-xs text-ink-400">
        <Show when={tasteTestAvailable() && !ab.testing}>
          <button class="flex items-center justify-between rounded-lg bg-gold-500/10 px-3 py-2 text-left font-semibold text-gold-300 ring-1 ring-gold-500/40 hover:bg-gold-500/15" onClick={() => tasteTest.show()}>
            <span>Can’t decide? Compare them side by side</span>
            <span aria-hidden="true">→</span>
          </button>
        </Show>
        <span>
          Like one better?{' '}
          <button
            class="font-semibold text-gold-300 hover:underline"
            onClick={() => {
              customize.close();
              feedbackPanel.show();
            }}
          >
            Tell us why
          </button>
        </span>
      </div>
    </div>
  );
}

export function CustomizeButton() {
  let wrapper: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (customize.open() && !wrapper?.contains(e.target as Node)) customize.close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && customize.close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    });
  });
  return (
    <div ref={(el) => (wrapper = el)} class="relative shrink-0">
      <button
        onClick={customize.toggle}
        aria-haspopup="dialog"
        aria-expanded={customize.open()}
        aria-label="Customize the look and sound"
        title="Customize the look and sound"
        class={`dl-type flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold ring-1 transition-colors ${
          customize.open() || customize.hint() ? 'bg-gold-500/15 text-gold-300 ring-gold-500/60' : 'text-ink-200 ring-ink-700 hover:bg-ink-850 hover:text-gold-300'
        }`}
      >
        <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" />
          <circle cx="7.5" cy="11" r="1.2" fill="currentColor" />
          <circle cx="10.5" cy="7" r="1.2" fill="currentColor" />
          <circle cx="15.5" cy="7.5" r="1.2" fill="currentColor" />
        </svg>
        <span class="hidden lg:inline">Customize</span>
        <Show when={customize.hint()}>
          <span class="absolute -right-1 -top-1 size-2.5 animate-pulse-soft rounded-full bg-gold-400" aria-hidden="true" />
        </Show>
      </button>
      <Show when={customize.open()}>
        <CustomizePanel />
      </Show>
    </div>
  );
}
