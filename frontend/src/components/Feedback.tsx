/**
 * Site feedback, docked in the corner instead of a pop-up: there is no dark overlay, so people can keep using and
 * looking at the site while they write, and the draft is kept while they move between pages. It can be minimised to
 * a small tab. The page, the screen size and the A/B versions go along with it, so
 * the admin dashboard can compare feedback between versions. Most people never open it: the taste test and the
 * one-tap rating (QuickRating.tsx) ask at the right moment instead; this is for those with more to say.
 */
import { useLocation } from '@solidjs/router';
import { createEffect, createRoot, createSignal, For, Show } from 'solid-js';
import { post } from '../api/client';
import { ab } from '../lib/experiments';
import { customize, feedbackPanel } from '../lib/panels';
import { prompts } from '../lib/prompts';
import { FACES as RATINGS, TagChips, tagsFor } from './QuickRating';
import { toast } from './toast';
import { Button } from './ui';

type Category = 'ui' | 'bug' | 'idea' | 'other';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'ui', label: 'Look & feel' },
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
];

const MAX = 2000;

/** The draft lives outside the component, so it survives minimising, closing and moving between pages. */
const draft = createRoot(() => {
  const [rating, setRating] = createSignal<number | null>(null);
  const [category, setCategory] = createSignal<Category>('ui');
  const [message, setMessage] = createSignal('');
  const [tags, setTags] = createSignal<string[]>([]);
  return { rating, setRating, category, setCategory, message, setMessage, tags, setTags };
});

const hasDraft = () => draft.rating() != null || draft.message().trim() !== '';

function Panel() {
  const location = useLocation();
  const [busy, setBusy] = createSignal(false);

  const submit = async () => {
    if (draft.rating() == null) return;
    setBusy(true);
    try {
      await post('/api/feedback', {
        visitorId: ab.visitorId(),
        rating: draft.rating(),
        category: draft.category(),
        message: draft.message().trim() || null,
        path: location.pathname.slice(0, 200),
        variants: ab.snapshot(),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        source: 'button',
        tags: draft.tags().filter((t) => tagsFor(draft.rating()).includes(t)),
      });
      toast.success('Thanks! Your feedback was sent.');
      prompts.rated();
      draft.setRating(null);
      draft.setMessage('');
      draft.setTags([]);
      feedbackPanel.close();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Send feedback"
      class="fixed inset-x-2 bottom-2 z-40 flex max-h-[75vh] animate-pop flex-col rounded-2xl border border-ink-600 bg-ink-900/97 shadow-2xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem]"
    >
      <header class="flex items-center justify-between gap-2 border-b border-ink-700 px-4 py-2.5">
        <h3 class="text-sm font-semibold">Send feedback</h3>
        <div class="flex gap-1">
          <button
            class="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            onClick={() => feedbackPanel.setMinimized(true)}
            aria-label="Minimise (keeps your draft)"
            title="Minimise (keeps your draft)"
          >
            —
          </button>
          <button
            class="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            onClick={feedbackPanel.close}
            aria-label="Close (keeps your draft)"
            title="Close (keeps your draft)"
          >
            ✕
          </button>
        </div>
      </header>
      <div class="flex flex-col gap-3 overflow-y-auto px-4 py-3">
        <p class="text-xs text-ink-400">Keep using the site while you write — this panel stays put and nothing is lost when you change pages.</p>
        <div class="flex justify-between gap-1" role="radiogroup" aria-label="How do you like the site?">
          <For each={RATINGS}>
            {(r) => (
              <button
                role="radio"
                aria-checked={draft.rating() === r.value}
                aria-label={r.label}
                title={r.label}
                class={`flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-xl transition-all ${
                  draft.rating() === r.value ? 'bg-gold-500/15 ring-1 ring-gold-400' : 'opacity-60 hover:bg-ink-800 hover:opacity-100'
                }`}
                onClick={() => draft.setRating(r.value)}
              >
                {r.face}
                <span class="text-[10px] font-semibold text-ink-400">{r.label}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={draft.rating() != null}>
          <TagChips
            tags={tagsFor(draft.rating())}
            selected={draft.tags()}
            onToggle={(t) => draft.setTags(draft.tags().includes(t) ? draft.tags().filter((x) => x !== t) : [...draft.tags(), t])}
          />
        </Show>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What is it about?">
          <For each={CATEGORIES}>
            {(c) => (
              <button
                role="radio"
                aria-checked={draft.category() === c.value}
                class={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition-colors ${
                  draft.category() === c.value ? 'bg-gold-500/15 text-gold-300 ring-gold-500/60' : 'text-ink-300 ring-ink-700 hover:bg-ink-800'
                }`}
                onClick={() => draft.setCategory(c.value)}
              >
                {c.label}
              </button>
            )}
          </For>
        </div>
        <label class="flex flex-col gap-1">
          <span class="sr-only">Your feedback</span>
          <textarea
            rows={4}
            maxLength={MAX}
            value={draft.message()}
            onInput={(e) => draft.setMessage(e.currentTarget.value)}
            placeholder="What did you like, what got in the way? (optional)"
            class="w-full resize-y rounded-lg border border-ink-600 bg-ink-950/60 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-gold-500 focus:outline-none"
          />
          <Show when={draft.message().length > MAX - 200}>
            <span class="text-right text-xs text-ink-400">{draft.message().length}/{MAX}</span>
          </Show>
        </label>
        <p class="text-[11px] text-ink-500">
          Sent with: this page ({location.pathname}), your screen size and your look.{' '}
          <button class="font-semibold text-gold-300 hover:underline" onClick={() => customize.show('look')}>Change the look</button>
        </p>
      </div>
      <footer class="flex items-center justify-end gap-2 border-t border-ink-700 px-4 py-2.5">
        <Show when={draft.rating() == null}>
          <span class="mr-auto text-[11px] text-ink-500">Pick a face to send</span>
        </Show>
        <Button size="sm" loading={busy()} disabled={draft.rating() == null} onClick={submit}>Send</Button>
      </footer>
    </section>
  );
}

/** The corner tab plus the panel. */
export function FeedbackDock() {
  // Reopening after a close shows the whole panel again, not the minimised tab.
  createEffect(() => {
    if (!feedbackPanel.open()) feedbackPanel.setMinimized(false);
  });
  return (
    <Show
      when={feedbackPanel.open() && !feedbackPanel.minimized()}
      fallback={
        <button
          onClick={feedbackPanel.show}
          class="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-ink-600 bg-ink-850/95 px-4 py-2.5 text-sm font-semibold text-ink-100 shadow-xl backdrop-blur transition-colors hover:border-gold-500 hover:text-gold-300"
        >
          <span aria-hidden="true">💬</span>
          Feedback
          <Show when={hasDraft()}>
            <span class="rounded-full bg-gold-500/20 px-1.5 text-[10px] font-bold uppercase text-gold-300">draft</span>
          </Show>
        </button>
      }
    >
      <Panel />
    </Show>
  );
}
