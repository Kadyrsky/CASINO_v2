/**
 * One-tap rating: five faces. The rating is sent on the first tap, so it counts even if the visitor goes no
 * further; then a few reason chips (one more tap) and an optional comment refine it. Used at the end of the taste
 * test and as the "how's it going?" card a few minutes into a visit.
 */
import { useLocation } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { post } from '../api/client';
import { ab } from '../lib/experiments';
import { prompts } from '../lib/prompts';

export const FACES = [
  { value: 1, face: '😞', label: 'Bad' },
  { value: 2, face: '🙁', label: 'Poor' },
  { value: 3, face: '😐', label: 'Okay' },
  { value: 4, face: '🙂', label: 'Good' },
  { value: 5, face: '😍', label: 'Great' },
];

/** Reason chips; the ids are stored with the feedback and counted on the dashboard. */
export const TAGS: Record<string, string> = {
  looks_great: 'Looks great',
  love_music: 'Love the music',
  nice_sounds: 'Nice sounds',
  fun_games: 'Fun games',
  easy: 'Easy to use',
  hard_to_read: 'Hard to read',
  too_dark: 'Too dark',
  music_annoying: 'Music is annoying',
  sounds_annoying: 'Sounds are annoying',
  confusing: 'Confusing',
  slow_buggy: 'Slow or buggy',
};
const GOOD = ['looks_great', 'love_music', 'nice_sounds', 'fun_games', 'easy'];
const BAD = ['hard_to_read', 'too_dark', 'music_annoying', 'sounds_annoying', 'confusing', 'slow_buggy'];

export function tagsFor(rating: number | null): string[] {
  if (rating == null) return [];
  if (rating >= 4) return GOOD;
  if (rating <= 2) return BAD;
  return ['looks_great', 'love_music', 'hard_to_read', 'music_annoying', 'sounds_annoying', 'confusing'];
}

export function TagChips(props: { tags: string[]; selected: string[]; onToggle: (tag: string) => void }) {
  return (
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Reasons">
      <For each={props.tags}>
        {(t) => (
          <button
            role="checkbox"
            aria-checked={props.selected.includes(t)}
            class={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-colors ${
              props.selected.includes(t) ? 'bg-gold-500/15 text-gold-300 ring-gold-500/60' : 'text-ink-300 ring-ink-700 hover:bg-ink-800'
            }`}
            onClick={() => props.onToggle(t)}
          >
            {TAGS[t] ?? t}
          </button>
        )}
      </For>
    </div>
  );
}

export function QuickRating(props: { source: 'pulse' | 'taste_test'; question: string; onDone: () => void }) {
  const location = useLocation();
  const [rating, setRating] = createSignal<number | null>(null);
  const [id, setId] = createSignal<number | null>(null);
  const [tags, setTags] = createSignal<string[]>([]);
  const [message, setMessage] = createSignal('');
  const [step, setStep] = createSignal<'rate' | 'why' | 'thanks'>('rate');

  const rate = (value: number) => {
    setRating(value);
    setStep('why');
    prompts.rated();
    post<{ id: number }>('/api/feedback', {
      visitorId: ab.visitorId(),
      rating: value,
      category: 'general',
      message: null,
      path: location.pathname.slice(0, 200),
      variants: ab.snapshot(),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      source: props.source,
    })
      .then((r) => setId(r?.id ?? null))
      .catch(() => {});
  };

  const finish = (send: boolean) => {
    const feedbackId = id();
    if (send && feedbackId != null && (tags().length || message().trim())) {
      post(`/api/feedback/${feedbackId}/details`, { visitorId: ab.visitorId(), tags: tags(), message: message().trim() || null }).catch(() => {});
    }
    setStep('thanks');
    window.setTimeout(props.onDone, 1400);
  };

  return (
    <div class="flex flex-col gap-3">
      <Show when={step() === 'rate'}>
        <p class="text-sm font-semibold text-ink-100">{props.question}</p>
        <div class="flex justify-between gap-1" role="radiogroup" aria-label={props.question}>
          <For each={FACES}>
            {(f) => (
              <button
                role="radio"
                aria-checked={rating() === f.value}
                aria-label={f.label}
                title={f.label}
                class="flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-2xl opacity-70 transition-all hover:-translate-y-0.5 hover:bg-ink-800 hover:opacity-100"
                onClick={() => rate(f.value)}
              >
                {f.face}
                <span class="text-[10px] font-semibold text-ink-400">{f.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={step() === 'why'}>
        <p class="text-sm font-semibold text-ink-100">
          {FACES[(rating() ?? 3) - 1]!.face} Thanks! What’s behind it? <span class="font-normal text-ink-400">(optional)</span>
        </p>
        <TagChips
          tags={tagsFor(rating())}
          selected={tags()}
          onToggle={(t) => setTags(tags().includes(t) ? tags().filter((x) => x !== t) : [...tags(), t])}
        />
        <textarea
          rows={2}
          maxLength={2000}
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          placeholder="Anything else? (optional)"
          aria-label="Comment"
          class="w-full resize-none rounded-lg border border-ink-600 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-gold-500 focus:outline-none"
        />
        <div class="flex justify-end gap-2">
          <button class="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-400 hover:bg-ink-800" onClick={() => finish(false)}>
            Skip
          </button>
          <button
            class="btn-dl dl-type rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-45"
            disabled={!tags().length && !message().trim()}
            onClick={() => finish(true)}
          >
            Send
          </button>
        </div>
      </Show>
      <Show when={step() === 'thanks'}>
        <p class="py-2 text-center text-sm font-semibold text-ink-100">Thank you — that really helps! 🙌</p>
      </Show>
    </div>
  );
}

/** The "how's it going?" card, a few minutes into a visit (see prompts.ts). */
export function PulseCard() {
  return (
    <section
      aria-label="Quick rating"
      class="fixed inset-x-2 bottom-2 z-40 animate-pop rounded-2xl border border-ink-600 bg-ink-900/97 p-4 shadow-2xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-[22rem]"
    >
      <button
        class="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100"
        onClick={prompts.close}
        aria-label="Not now"
        title="Not now"
      >
        ✕
      </button>
      <QuickRating source="pulse" question="Quick one: how’s Naebka so far?" onDone={prompts.close} />
    </section>
  );
}
