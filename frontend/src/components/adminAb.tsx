/** Admin dashboard cards for the A/B experiments and site feedback (see src/lib/experiments.ts). */
import { createQuery } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import { get } from '../api/client';
import { EXPERIMENTS, type Goal } from '../lib/experiments';
import { ago, humanize } from '../lib/format';
import { Badge, Card, Empty, Select } from './ui';

interface VariantResult {
  variant: string;
  visitors: number;
  switchedAway: number;
  onItNow: number;
  goals: Record<string, number>;
  avgRating: number | null;
  ratings: number;
}

interface ExperimentResult {
  experiment: string;
  variants: VariantResult[];
  switches: { from: string; to: string; count: number }[];
}

interface FeedbackItem {
  id: number;
  username: string | null;
  rating: number;
  category: string;
  message: string | null;
  path: string;
  variants: Record<string, string>;
  viewport: string | null;
  userAgent: string | null;
  createdAt: string;
}

const GOALS: { key: Goal; label: string }[] = [
  { key: 'registered', label: 'Registered' },
  { key: 'bet_placed', label: 'Bet placed' },
  { key: 'slot_spin', label: 'Spun slots' },
  { key: 'poker_sit', label: 'Sat at poker' },
];

const FACES = ['', '😞', '🙁', '😐', '🙂', '😍'];

const title = (key: string) => EXPERIMENTS.find((e) => e.key === key)?.title ?? key;
const variantLabel = (exp: string, id: string) =>
  EXPERIMENTS.find((e) => e.key === exp)?.variants.find((v) => v.id === id)?.label ?? id;
/** The first variant in the registry is the current site. */
const controlId = (exp: string) => EXPERIMENTS.find((e) => e.key === exp)?.variants[0]?.id;
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '–');

/** Registry order, so the control (the current site) comes first. */
function ordered(exp: string, variants: VariantResult[]) {
  const ids = EXPERIMENTS.find((e) => e.key === exp)?.variants.map((v) => v.id) ?? [];
  const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
  return [...variants].sort((a, b) => rank(a.variant) - rank(b.variant));
}

/**
 * Two-sided p-value of a two-proportion z-test: how likely a gap this big is by pure chance. Below 0.05 the
 * difference is unlikely to be luck.
 */
function pValue(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 < 1 || n2 < 1) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  // Abramowitz–Stegun approximation of the normal tail.
  const t = 1 / (1 + 0.2316419 * z);
  const tail = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 2 * tail;
}

export function ExperimentsCard() {
  const results = createQuery(() => ({
    queryKey: ['admin-ab'],
    queryFn: () => get<ExperimentResult[]>('/api/admin/ab/results'),
    refetchInterval: 30_000,
  }));
  return (
    <Card
      title="A/B experiments"
      class="mt-6"
      actions={<span class="text-xs text-ink-400">Counted by the version people were first given</span>}
    >
      <Show when={results.data?.length} fallback={<Empty title="No visitors yet" icon="⚗">Results appear once people open the site.</Empty>}>
        <div class="flex flex-col divide-y divide-ink-800">
          <For each={results.data}>
            {(exp) => {
              const rows = () => ordered(exp.experiment, exp.variants);
              const control = () => rows().find((v) => v.variant === controlId(exp.experiment));
              return (
                <section class="px-4 py-4">
                  <h3 class="font-semibold">
                    {title(exp.experiment)} <span class="font-mono text-xs font-normal text-ink-400">{exp.experiment}</span>
                  </h3>
                  <div class="mt-3 overflow-x-auto">
                    <table class="w-full min-w-[640px] text-left text-sm">
                      <thead class="text-[11px] uppercase tracking-wider text-ink-400">
                        <tr>
                          <th class="py-1.5 pr-3 font-semibold">Version</th>
                          <th class="py-1.5 pr-3 font-semibold">Given to</th>
                          <th class="py-1.5 pr-3 font-semibold" title="Of the people given this version, how many switched to another one">Switched away</th>
                          <th class="py-1.5 pr-3 font-semibold" title="People on this version now, whether given or picked">On it now</th>
                          <For each={GOALS}>{(g) => <th class="py-1.5 pr-3 font-semibold">{g.label}</th>}</For>
                          <th class="py-1.5 font-semibold">Rating</th>
                        </tr>
                      </thead>
                      <tbody class="tabular">
                        <For each={rows()}>
                          {(v) => (
                            <tr class="border-t border-ink-800">
                              <td class="py-2 pr-3 font-semibold">
                                {variantLabel(exp.experiment, v.variant)}
                                <Show when={v.variant === controlId(exp.experiment)}>
                                  <span class="ml-1.5 text-[10px] font-normal text-ink-500">control</span>
                                </Show>
                              </td>
                              <td class="py-2 pr-3">{v.visitors}</td>
                              <td class={`py-2 pr-3 ${v.visitors && v.switchedAway / v.visitors > 0.2 ? 'text-loss' : ''}`}>
                                {v.switchedAway} <span class="text-ink-400">({pct(v.switchedAway, v.visitors)})</span>
                              </td>
                              <td class="py-2 pr-3">{v.onItNow}</td>
                              <For each={GOALS}>
                                {(g) => {
                                  const n = () => v.goals[g.key] ?? 0;
                                  const p = () => {
                                    const c = control();
                                    return !c || c === v ? null : pValue(n(), v.visitors, c.goals[g.key] ?? 0, c.visitors);
                                  };
                                  return (
                                    <td class="py-2 pr-3">
                                      {pct(n(), v.visitors)} <span class="text-ink-400">({n()})</span>
                                      <Show when={p() != null && p()! < 0.05}>
                                        <span class="ml-1 text-win" title={`p = ${p()!.toFixed(3)}: unlikely to be chance`}>✱</span>
                                      </Show>
                                    </td>
                                  );
                                }}
                              </For>
                              <td class="py-2">
                                <Show when={v.avgRating != null} fallback={<span class="text-ink-500">–</span>}>
                                  {v.avgRating!.toFixed(1)} <span class="text-ink-400">({v.ratings})</span>
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                  <Show when={exp.switches.length}>
                    <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      Switches:
                      <For each={exp.switches}>
                        {(s) => (
                          <Badge>
                            {variantLabel(exp.experiment, s.from)} → {variantLabel(exp.experiment, s.to)}: {s.count}
                          </Badge>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              );
            }}
          </For>
        </div>
        <p class="border-t border-ink-800 px-4 py-3 text-xs text-ink-400">
          ✱ = differs from the control by more than chance would explain (p &lt; 0.05). To trust a gap like 10% vs 15%
          you need about 700 people per version; before that, the switch counts and feedback say more. Ratings are
          grouped by the version people were on when they wrote feedback. Visitors opened with <code>?ab=</code> are not counted.
        </p>
      </Show>
    </Card>
  );
}

export function FeedbackCard() {
  const [filter, setFilter] = createSignal('');
  const feedback = createQuery(() => ({
    queryKey: ['admin-feedback', filter()],
    queryFn: () => {
      const [experiment, variant] = filter().split(':');
      return get<FeedbackItem[]>('/api/admin/feedback', { experiment, variant });
    },
    refetchInterval: 30_000,
  }));
  const average = () => {
    const items = feedback.data ?? [];
    return items.length ? (items.reduce((s, f) => s + f.rating, 0) / items.length).toFixed(1) : null;
  };
  return (
    <Card
      title="Feedback"
      class="mt-6"
      actions={
        <div class="flex items-center gap-3">
          <Show when={average()}>
            {(avg) => <span class="text-xs text-ink-400">avg {avg()} of {feedback.data?.length}</span>}
          </Show>
          <Select class="!h-8 w-48 text-xs" value={filter()} onChange={(e) => setFilter(e.currentTarget.value)} aria-label="Filter by version">
            <option value="">All versions</option>
            <For each={EXPERIMENTS}>
              {(e) => (
                <optgroup label={e.title}>
                  <For each={e.variants}>{(v) => <option value={`${e.key}:${v.id}`}>{v.label}</option>}</For>
                </optgroup>
              )}
            </For>
          </Select>
        </div>
      }
    >
      <Show when={feedback.data?.length} fallback={<Empty title="No feedback yet" icon="💬">Feedback sent with the button in the corner shows up here.</Empty>}>
        <ul class="divide-y divide-ink-800">
          <For each={feedback.data}>
            {(f) => (
              <li class="flex gap-3 px-4 py-3">
                <span class="text-2xl" title={`${f.rating} of 5`}>{FACES[f.rating]}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                    <Badge tone={f.category === 'bug' ? 'loss' : f.category === 'idea' ? 'blue' : 'neutral'}>{humanize(f.category === 'ui' ? 'look & feel' : f.category)}</Badge>
                    <span class="font-semibold text-ink-200">{f.username ?? 'anonymous'}</span>
                    <span>on <span class="font-mono">{f.path}</span></span>
                    <span>{ago(f.createdAt)}</span>
                    <Show when={f.viewport}><span>{f.viewport}</span></Show>
                  </div>
                  {/* Plain text: Solid escapes it, so nothing a visitor writes can run as HTML. */}
                  <Show when={f.message}>
                    <p class="mt-1 whitespace-pre-wrap break-words text-sm text-ink-100">{f.message}</p>
                  </Show>
                  <div class="mt-1.5 flex flex-wrap gap-1.5">
                    <For each={Object.entries(f.variants)}>
                      {([k, v]) => <span class="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">{title(k)}: {variantLabel(k, v)}</span>}
                    </For>
                  </div>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}
