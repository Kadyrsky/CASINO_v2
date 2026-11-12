/**
 * Admin dashboard cards for the A/B experiments, the taste test and site feedback (see src/lib/experiments.ts and
 * docs/ab-testing.md). Numbers come with how sure we can be, in words, because about a hundred visitors is too few
 * for a pass/fail significance test to say anything but "not significant".
 */
import { createQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { get } from '../api/client';
import { EXPERIMENTS, type Experiment, type Goal, variantLabel } from '../lib/experiments';
import { ago, humanize } from '../lib/format';
import { bradleyTerry, chanceBestPaired, chanceBestRates, confidence, median, wilson, type Confidence, type PairVote } from '../lib/stats';
import { TAGS } from './QuickRating';
import { Badge, Card, Empty, Select } from './ui';

interface VariantResult {
  variant: string;
  visitors: number;
  switchedAway: number;
  pickedInTasteTest: number;
  onItNow: number;
  goals: Record<string, number>;
  avgRating: number | null;
  ratings: number;
}

interface ExperimentResult {
  experiment: string;
  variants: VariantResult[];
  switches: { from: string; to: string; source: string; count: number }[];
}

interface VoteRow {
  experiment: string;
  variantA: string;
  variantB: string;
  left: string;
  winner: string | null;
  previewedBoth: boolean;
  decisionMs: number | null;
  visitorId: string;
  createdAt: string;
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
  source: 'button' | 'pulse' | 'taste_test';
  tags: string[];
  createdAt: string;
}

interface VisitorRow {
  visitorId: string;
  registered: boolean;
  firstSeen: string;
  assigned: Record<string, string>;
  current: Record<string, string>;
  goals: string[];
  switchesByHand: number;
  tasteTestAnswers: number;
}

const GOALS: { key: Goal; label: string }[] = [
  { key: 'registered', label: 'Registered' },
  { key: 'bet_placed', label: 'Bet placed' },
  { key: 'slot_spin', label: 'Spun slots' },
  { key: 'poker_sit', label: 'Sat at poker' },
];
const METRIC_LABELS: Record<string, string> = {
  changed: 'changed it by hand',
  music_off: 'turned the music off',
  sounds_off: 'turned the sounds off',
  registered: 'registered',
  bet_placed: 'placed a bet',
  slot_spin: 'spun the slots',
  poker_sit: 'sat at poker',
};
const SOURCES: Record<FeedbackItem['source'], string> = { button: 'Feedback button', pulse: 'One-tap rating', taste_test: 'After taste test' };
const FACES = ['', '😞', '🙁', '😐', '🙂', '😍'];

const CONFIDENCE: Record<Confidence, { label: string; tone: 'win' | 'gold' | 'neutral' }> = {
  clear: { label: 'Clear winner', tone: 'win' },
  likely: { label: 'Likely winner', tone: 'gold' },
  close: { label: 'Too close to call', tone: 'neutral' },
  early: { label: 'Too early', tone: 'neutral' },
};

const exp = (key: string) => EXPERIMENTS.find((e) => e.key === key);
const title = (key: string) => exp(key)?.title ?? key;
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(0)}%` : '–');
const percent = (x: number) => `${Math.round(100 * x)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- CSV export ----

/** One CSV cell; values that a spreadsheet would run as a formula get a leading quote (CSV injection). */
function cell(value: unknown): string {
  let s = value == null ? '' : Array.isArray(value) ? value.join(' ') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CsvButton(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button class="rounded-md px-2 py-1 text-xs font-semibold text-ink-300 ring-1 ring-ink-700 hover:bg-ink-800 hover:text-ink-100" onClick={props.onClick}>
      ⤓ {props.children}
    </button>
  );
}

// ---- Taste test ----

interface TasteSummary {
  experiment: Experiment;
  rows: { id: string; strength: number; best: number; wins: number; games: number; ci: [number, number] }[];
  answers: number;
  decided: number;
  confidence: Confidence;
  leftWins: number;
  previewed: number;
  medianMs: number | null;
  headToHead: (a: string, b: string) => [number, number];
}

function summarize(e: Experiment, votes: VoteRow[]): TasteSummary {
  const items = e.variants.filter((v) => !v.pickOnly).map((v) => v.id);
  const mine = votes.filter((v) => v.experiment === e.key && items.includes(v.variantA) && items.includes(v.variantB));
  const decided = mine.filter((v) => v.winner);
  const pairs: PairVote[] = decided.map((v) => ({ winner: v.winner!, loser: v.winner === v.variantA ? v.variantB : v.variantA }));
  const strength = bradleyTerry(items, pairs);
  const best = chanceBestPaired(items, pairs);
  const rows = items
    .map((id) => {
      const games = decided.filter((v) => v.variantA === id || v.variantB === id);
      const wins = games.filter((v) => v.winner === id).length;
      return { id, strength: strength[id]!, best: best[id]!, wins, games: games.length, ci: wilson(wins, games.length) };
    })
    // By the decision number (chance it's the favourite), then the preference share.
    .sort((a, b) => b.best - a.best || b.strength - a.strength);
  return {
    experiment: e,
    rows,
    answers: mine.length,
    decided: decided.length,
    confidence: confidence(rows[0]?.best ?? 0, decided.length),
    leftWins: decided.filter((v) => v.winner === v.left).length,
    previewed: mine.filter((v) => v.previewedBoth).length,
    medianMs: median(mine.flatMap((v) => (v.decisionMs == null ? [] : [v.decisionMs]))),
    headToHead: (a, b) => {
      const games = decided.filter((v) => (v.variantA === a && v.variantB === b) || (v.variantA === b && v.variantB === a));
      return [games.filter((v) => v.winner === a).length, games.filter((v) => v.winner === b).length];
    },
  };
}

function useVotes() {
  return createQuery(() => ({
    queryKey: ['admin-ab-votes'],
    queryFn: () => get<VoteRow[]>('/api/admin/ab/votes'),
    refetchInterval: 30_000,
  }));
}

function useResults() {
  return createQuery(() => ({
    queryKey: ['admin-ab'],
    queryFn: () => get<ExperimentResult[]>('/api/admin/ab/results'),
    refetchInterval: 30_000,
  }));
}

function ConfidenceBadge(props: { level: Confidence }) {
  return <Badge tone={CONFIDENCE[props.level].tone}>{CONFIDENCE[props.level].label}</Badge>;
}

/** The answer to "which combination is best?": the leader of each experiment, and how sure we are. */
export function RecommendationCard() {
  const votes = useVotes();
  const results = useResults();
  const taste = createMemo(() => EXPERIMENTS.filter((e) => e.taste).map((e) => summarize(e, votes.data ?? [])));
  const others = createMemo(() =>
    EXPERIMENTS.filter((e) => !e.taste).flatMap((e) => {
      const r = results.data?.find((x) => x.experiment === e.key);
      if (!r) return [];
      const arms = r.variants.filter((v) => v.visitors > 0).map((v) => ({ id: v.variant, x: metricCount(e, v), n: v.visitors }));
      if (arms.length < 2) return [];
      const chance = chanceBestRates(arms, e.primary.better);
      const lead = [...arms].sort((a, b) => chance[b.id]! - chance[a.id]!)[0]!;
      const n = arms.reduce((s, a) => s + a.n, 0);
      return [{ e, lead: lead.id, chance: chance[lead.id]!, n, level: confidence(chance[lead.id]!, n, 30) }];
    }),
  );
  return (
    <Card title="Recommended combination (so far)" class="mt-6" actions={<span class="text-xs text-ink-400">Decide with the rule in docs/ab-testing.md</span>}>
      <ul class="divide-y divide-ink-800">
        <For each={taste()}>
          {(s) => (
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span class="w-28 text-xs font-semibold uppercase tracking-wider text-ink-400">{s.experiment.title}</span>
              <span class="font-semibold">{s.decided ? variantLabel(s.experiment.key, s.rows[0]!.id) : '–'}</span>
              <ConfidenceBadge level={s.confidence} />
              <span class="text-xs text-ink-400">
                <Show when={s.decided} fallback="no taste-test answers yet">
                  {percent(s.rows[0]!.best)} chance it's the favourite · {plural(s.decided, 'answer')}
                </Show>
              </span>
            </li>
          )}
        </For>
        <For each={others()}>
          {(o) => (
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span class="w-28 text-xs font-semibold uppercase tracking-wider text-ink-400">{o.e.title}</span>
              <span class="font-semibold">{variantLabel(o.e.key, o.lead)}</span>
              <ConfidenceBadge level={o.level} />
              <span class="text-xs text-ink-400">
                {percent(o.chance)} chance it has the {o.e.primary.better === 'higher' ? 'most' : 'fewest'} who {METRIC_LABELS[o.e.primary.metric]} · {plural(o.n, 'visitor')}
              </span>
            </li>
          )}
        </For>
      </ul>
      <p class="border-t border-ink-800 px-4 py-3 text-xs text-ink-400">
        The taste test asks people directly which of two versions they like more, so each answer counts in full; experiments without
        a taste-test question are judged on their primary number between visitors. "Clear" is 95%+, "likely" 80%+. Each experiment is
        judged on its own: with this many visitors, which theme goes best with which music can't be measured, so the best
        combination is the best of each.
      </p>
    </Card>
  );
}

export function TasteTestCard() {
  const votes = useVotes();
  const summaries = createMemo(() => EXPERIMENTS.filter((e) => e.taste).map((e) => summarize(e, votes.data ?? [])));
  const exportVotes = () =>
    downloadCsv(
      'naebka-taste-test',
      ['created_at', 'visitor_id', 'experiment', 'variant_a', 'variant_b', 'shown_left', 'winner', 'previewed_both', 'decision_ms'],
      (votes.data ?? []).map((v) => [v.createdAt, v.visitorId, v.experiment, v.variantA, v.variantB, v.left, v.winner ?? 'no_preference', v.previewedBoth, v.decisionMs]),
    );
  return (
    <Card
      title="Taste test: which do people like more?"
      class="mt-6"
      actions={
        <div class="flex items-center gap-3">
          <span class="text-xs text-ink-400">{plural(votes.data?.length ?? 0, 'answer')}</span>
          <CsvButton onClick={exportVotes}>CSV</CsvButton>
        </div>
      }
    >
      <Show when={votes.data?.length} fallback={<Empty title="No answers yet" icon="⚖">Answers appear as visitors take the taste test.</Empty>}>
        <div class="flex flex-col divide-y divide-ink-800">
          <For each={summaries()}>
            {(s) => (
              <section class="px-4 py-4">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="font-semibold">{s.experiment.title}</h3>
                  <ConfidenceBadge level={s.confidence} />
                  <span class="text-xs text-ink-400">
                    {plural(s.decided, 'answer')}{s.answers > s.decided ? ` + ${s.answers - s.decided} no preference` : ''}
                  </span>
                </div>
                <div class="mt-3 overflow-x-auto">
                  <table class="w-full min-w-[560px] text-left text-sm">
                    <thead class="text-[11px] uppercase tracking-wider text-ink-400">
                      <tr>
                        <th class="py-1.5 pr-3 font-semibold">Version</th>
                        <th class="py-1.5 pr-3 font-semibold" title="Bradley–Terry strength: its share of the preference, from all head-to-heads at once">Preference</th>
                        <th class="py-1.5 pr-3 font-semibold">Won</th>
                        <th class="py-1.5 pr-3 font-semibold" title="Share of its head-to-heads it won, with the 95% range">Win rate (95% range)</th>
                        <th class="py-1.5 font-semibold" title="How often it comes out on top when the test is re-run 1,000 times in simulation from these answers">Chance it's the favourite</th>
                      </tr>
                    </thead>
                    <tbody class="tabular">
                      <For each={s.rows}>
                        {(r, i) => (
                          <tr class="border-t border-ink-800">
                            <td class="py-2 pr-3 font-semibold">
                              {i() + 1}. {variantLabel(s.experiment.key, r.id)}
                            </td>
                            <td class="py-2 pr-3">{percent(r.strength)}</td>
                            <td class="py-2 pr-3">
                              {r.wins} <span class="text-ink-400">of {r.games}</span>
                            </td>
                            <td class="py-2 pr-3">
                              <div class="flex items-center gap-2">
                                <span class="w-9">{r.games ? percent(r.wins / r.games) : '–'}</span>
                                <span class="relative h-1.5 w-28 rounded-full bg-ink-800" aria-hidden="true">
                                  <span class="absolute inset-y-0 rounded-full bg-gold-500/40" style={{ left: `${r.ci[0] * 100}%`, right: `${100 - r.ci[1] * 100}%` }} />
                                  <span class="absolute inset-y-[-2px] w-0.5 rounded bg-gold-300" style={{ left: `${r.games ? (r.wins / r.games) * 100 : 50}%` }} />
                                  <span class="absolute inset-y-[-3px] left-1/2 w-px bg-ink-500" />
                                </span>
                              </div>
                            </td>
                            <td class="py-2 font-semibold">{percent(r.best)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <Show when={s.rows.length > 2}>
                  <div class="mt-3 flex flex-wrap gap-1.5 text-xs">
                    <For each={s.rows.flatMap((a, i) => s.rows.slice(i + 1).map((b) => [a.id, b.id] as const))}>
                      {([a, b]) => {
                        const [wa, wb] = s.headToHead(a, b);
                        return (
                          <span class="rounded bg-ink-800 px-2 py-0.5 text-ink-300">
                            {variantLabel(s.experiment.key, a)} {wa}–{wb} {variantLabel(s.experiment.key, b)}
                          </span>
                        );
                      }}
                    </For>
                  </div>
                </Show>
                <p class="mt-2 text-xs text-ink-400">
                  Tried both before answering: {pct(s.previewed, s.answers)} · picked the left one: {pct(s.leftWins, s.decided)}
                  <Show when={s.decided >= 20 && Math.abs(s.leftWins / s.decided - 0.5) > 0.15}>
                    <span class="text-warn"> (lopsided: people may be picking a side, not a version)</span>
                  </Show>{' '}
                  · typical answer time: {s.medianMs == null ? '–' : `${(s.medianMs / 1000).toFixed(1)} s`}
                </p>
              </section>
            )}
          </For>
        </div>
      </Show>
    </Card>
  );
}

// ---- Between visitors (random assignment) ----

function metricCount(e: Experiment, v: VariantResult): number {
  return e.primary.metric === 'changed' ? v.switchedAway : (v.goals[e.primary.metric] ?? 0);
}

/** Registry order, so the control (the first variant) comes first. */
function ordered(key: string, variants: VariantResult[]) {
  const ids = exp(key)?.variants.map((v) => v.id) ?? [];
  const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
  return [...variants].sort((a, b) => rank(a.variant) - rank(b.variant));
}

export function ExperimentsCard() {
  const results = useResults();
  const exportVisitors = async () => {
    const rows = await get<VisitorRow[]>('/api/admin/ab/visitors');
    const keys = EXPERIMENTS.map((e) => e.key);
    const goals: Goal[] = ['registered', 'bet_placed', 'slot_spin', 'poker_sit', 'music_off', 'sounds_off'];
    downloadCsv(
      'naebka-visitors',
      ['visitor_id', 'first_seen', 'registered_user', ...keys.flatMap((k) => [`${k}_assigned`, `${k}_now`]), ...goals, 'switches_by_hand', 'taste_test_answers'],
      rows.map((r) => [
        r.visitorId,
        r.firstSeen,
        r.registered,
        ...keys.flatMap((k) => [r.assigned[k] ?? '', r.current[k] ?? '']),
        ...goals.map((g) => (r.goals.includes(g) ? 1 : 0)),
        r.switchesByHand,
        r.tasteTestAnswers,
      ]),
    );
  };
  return (
    <Card
      title="Between visitors: each was given one version at random"
      class="mt-6"
      actions={
        <div class="flex items-center gap-3">
          <span class="hidden text-xs text-ink-400 sm:inline">Counted by the version people were first given</span>
          <CsvButton onClick={() => void exportVisitors()}>Visitors CSV</CsvButton>
        </div>
      }
    >
      <Show when={results.data?.length} fallback={<Empty title="No visitors yet" icon="⚗">Results appear once people open the site.</Empty>}>
        <div class="flex flex-col divide-y divide-ink-800">
          <For each={results.data}>
            {(r) => {
              const e = () => exp(r.experiment);
              const rows = () => ordered(r.experiment, r.variants);
              const audioGoal = (): Goal | null => (r.experiment === 'music' ? 'music_off' : r.experiment === 'sfx_pack' ? 'sounds_off' : null);
              const verdict = createMemo(() => {
                const ex = e();
                if (!ex) return null;
                const arms = rows().filter((v) => v.visitors > 0).map((v) => ({ id: v.variant, x: metricCount(ex, v), n: v.visitors }));
                if (arms.length < 2) return null;
                const chance = chanceBestRates(arms, ex.primary.better);
                const lead = [...arms].sort((a, b) => chance[b.id]! - chance[a.id]!)[0]!;
                const n = arms.reduce((s, a) => s + a.n, 0);
                return { ex, lead: lead.id, chance: chance[lead.id]!, level: confidence(chance[lead.id]!, n, 30) };
              });
              return (
                <section class="px-4 py-4">
                  <h3 class="font-semibold">
                    {title(r.experiment)} <span class="font-mono text-xs font-normal text-ink-400">{r.experiment}</span>
                  </h3>
                  <div class="mt-3 overflow-x-auto">
                    <table class="w-full min-w-[720px] text-left text-sm">
                      <thead class="text-[11px] uppercase tracking-wider text-ink-400">
                        <tr>
                          <th class="py-1.5 pr-3 font-semibold">Version</th>
                          <th class="py-1.5 pr-3 font-semibold">Given to</th>
                          <th class="py-1.5 pr-3 font-semibold" title="Of the people given this version, how many switched away from it under Customize">
                            Changed by hand
                          </th>
                          <th class="py-1.5 pr-3 font-semibold" title="Of the people given this version, how many changed it by answering the taste test">
                            Changed in taste test
                          </th>
                          <th class="py-1.5 pr-3 font-semibold" title="People on this version now, whether given or picked">On it now</th>
                          <Show when={audioGoal()}>
                            {(g) => <th class="py-1.5 pr-3 font-semibold">{g() === 'music_off' ? 'Music off' : 'Sounds off'}</th>}
                          </Show>
                          <For each={GOALS}>{(g) => <th class="py-1.5 pr-3 font-semibold">{g.label}</th>}</For>
                          <th class="py-1.5 font-semibold">Rating</th>
                        </tr>
                      </thead>
                      <tbody class="tabular">
                        <For each={rows()}>
                          {(v) => (
                            <tr class="border-t border-ink-800">
                              <td class="py-2 pr-3 font-semibold">{variantLabel(r.experiment, v.variant)}</td>
                              <td class="py-2 pr-3">{v.visitors}</td>
                              <td class={`py-2 pr-3 ${v.visitors && v.switchedAway / v.visitors > 0.2 ? 'text-loss' : ''}`}>
                                {v.switchedAway} <span class="text-ink-400">({pct(v.switchedAway, v.visitors)})</span>
                              </td>
                              <td class="py-2 pr-3">
                                {v.pickedInTasteTest} <span class="text-ink-400">({pct(v.pickedInTasteTest, v.visitors)})</span>
                              </td>
                              <td class="py-2 pr-3">{v.onItNow}</td>
                              <Show when={audioGoal()}>
                                {(g) => (
                                  <td class="py-2 pr-3">
                                    {v.goals[g()] ?? 0} <span class="text-ink-400">({pct(v.goals[g()] ?? 0, v.visitors)})</span>
                                  </td>
                                )}
                              </Show>
                              <For each={GOALS}>
                                {(g) => (
                                  <td class="py-2 pr-3">
                                    {pct(v.goals[g.key] ?? 0, v.visitors)} <span class="text-ink-400">({v.goals[g.key] ?? 0})</span>
                                  </td>
                                )}
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
                  <Show when={verdict()}>
                    {(d) => (
                      <p class="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                        <span>
                          Judged on who {METRIC_LABELS[d().ex.primary.metric]} ({d().ex.primary.better} is better):{' '}
                          <span class="font-semibold text-ink-200">{variantLabel(r.experiment, d().lead)}</span>, {percent(d().chance)} chance it's
                          truly the {d().ex.primary.better === 'higher' ? 'highest' : 'lowest'}
                        </span>
                        <ConfidenceBadge level={d().level} />
                      </p>
                    )}
                  </Show>
                  <Show when={r.switches.length}>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      Switches:
                      <For each={r.switches}>
                        {(s) => (
                          <Badge>
                            {variantLabel(r.experiment, s.from)} → {variantLabel(r.experiment, s.to)}: {s.count}
                            {s.source === 'taste_test' ? ' (taste test)' : ''}
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
          Each experiment is judged on one number chosen before the test (its primary metric), with the chance each version is truly
          best. With ~30 visitors per version only big gaps show up, which is why the taste test above carries more weight. Ratings
          are grouped by the version people were on when they rated. Visitors opened with <code>?ab=</code> are not counted.
        </p>
      </Show>
    </Card>
  );
}

// ---- Feedback ----

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
  const items = () => feedback.data ?? [];
  const average = () => (items().length ? (items().reduce((s, f) => s + f.rating, 0) / items().length).toFixed(1) : null);
  const bySource = () => (Object.keys(SOURCES) as FeedbackItem['source'][]).map((s) => [s, items().filter((f) => f.source === s).length] as const);
  const topTags = createMemo(() => {
    const counts = new Map<string, number>();
    for (const f of items()) for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });
  const exportFeedback = () =>
    downloadCsv(
      'naebka-feedback',
      ['created_at', 'source', 'rating', 'category', 'tags', 'message', 'path', 'username', 'viewport', ...EXPERIMENTS.map((e) => e.key)],
      items().map((f) => [f.createdAt, f.source, f.rating, f.category, f.tags, f.message, f.path, f.username, f.viewport, ...EXPERIMENTS.map((e) => f.variants[e.key] ?? '')]),
    );
  return (
    <Card
      title="Feedback"
      class="mt-6"
      actions={
        <div class="flex items-center gap-3">
          <Show when={average()}>{(avg) => <span class="text-xs text-ink-400">avg {avg()} of {items().length}</span>}</Show>
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
          <CsvButton onClick={exportFeedback}>CSV</CsvButton>
        </div>
      }
    >
      <Show when={items().length} fallback={<Empty title="No feedback yet" icon="💬">Ratings from the taste test, the one-tap card and the Feedback button show up here.</Empty>}>
        <div class="flex flex-col gap-2 border-b border-ink-800 px-4 py-3 text-xs text-ink-400">
          <div class="flex flex-wrap gap-3">
            <For each={bySource()}>
              {([s, n]) => (
                <span>
                  {SOURCES[s]}: <span class="font-semibold text-ink-200">{n}</span>
                </span>
              )}
            </For>
          </div>
          <Show when={topTags().length}>
            <div class="flex flex-wrap items-center gap-1.5">
              Reasons:
              <For each={topTags()}>
                {([t, n]) => (
                  <Badge tone={['hard_to_read', 'too_dark', 'music_annoying', 'sounds_annoying', 'confusing', 'slow_buggy'].includes(t) ? 'loss' : 'win'}>
                    {TAGS[t] ?? humanize(t)} {n}
                  </Badge>
                )}
              </For>
            </div>
          </Show>
        </div>
        <ul class="divide-y divide-ink-800">
          <For each={items()}>
            {(f) => (
              <li class="flex gap-3 px-4 py-3">
                <span class="text-2xl" title={`${f.rating} of 5`}>{FACES[f.rating]}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                    <Badge tone={f.category === 'bug' ? 'loss' : f.category === 'idea' ? 'blue' : 'neutral'}>
                      {humanize(f.category === 'ui' ? 'look & feel' : f.category)}
                    </Badge>
                    <span class="rounded bg-ink-800 px-1.5 py-0.5 text-[10px]">{SOURCES[f.source] ?? f.source}</span>
                    <span class="font-semibold text-ink-200">{f.username ?? 'anonymous'}</span>
                    <span>
                      on <span class="font-mono">{f.path}</span>
                    </span>
                    <span>{ago(f.createdAt)}</span>
                    <Show when={f.viewport}>
                      <span>{f.viewport}</span>
                    </Show>
                  </div>
                  <Show when={f.tags.length}>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <For each={f.tags}>{(t) => <span class="rounded-full bg-gold-500/10 px-2 py-0.5 text-[11px] text-gold-300">{TAGS[t] ?? t}</span>}</For>
                    </div>
                  </Show>
                  {/* Plain text: Solid escapes it, so nothing a visitor writes can run as HTML. */}
                  <Show when={f.message}>
                    <p class="mt-1 whitespace-pre-wrap break-words text-sm text-ink-100">{f.message}</p>
                  </Show>
                  <div class="mt-1.5 flex flex-wrap gap-1.5">
                    <For each={Object.entries(f.variants)}>
                      {([k, v]) => (
                        <span class="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">
                          {title(k)}: {variantLabel(k, v)}
                        </span>
                      )}
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
