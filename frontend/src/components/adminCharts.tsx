/**
 * The admin dashboard's Charts view: the same data as the Tables view (adminAb.tsx), drawn so the state of the test
 * is visible at a glance. Activity over time, the taste-test preferences, who is on which version, and what the
 * ratings and reasons say. The Tables view keeps every exact figure and the CSV exports.
 */
import { createMemo, createSignal, For, Show } from 'solid-js';
import { EXPERIMENTS, variantLabel, type Experiment } from '../lib/experiments';
import { ChartTooltip, Columns, Donut, LineChart, Legend, SERIES, StatTile, BarList, type BarRow } from './charts';
import { ConfidenceBadge, FACES, SOURCES, summarize, useFeedback, useResults, useVisitors, useVotes, type FeedbackItem } from './adminAb';
import { TAGS } from './QuickRating';
import { Card, Tabs } from './ui';

const HOUR = 3_600_000;
const SIZES = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * 24 * HOUR];
const NEGATIVE = new Set(['hard_to_read', 'too_dark', 'music_annoying', 'sounds_annoying', 'confusing', 'slow_buggy']);

/** A version keeps its colour everywhere: its place in the experiment's list. */
const colorOf = (e: Experiment, id: string) => SERIES[Math.max(0, e.variants.findIndex((v) => v.id === id)) % SERIES.length]!;
const percent = (x: number) => `${Math.round(100 * x)}%`;

/** Counts per time bucket for each list of timestamps, with as few buckets as reads well (<= 36). */
function timeline(lists: number[][], from: number, to: number) {
  const span = Math.max(HOUR, to - from);
  const size = SIZES.find((s) => span / s <= 36) ?? SIZES[SIZES.length - 1]!;
  const tz = new Date().getTimezoneOffset() * 60_000;
  const start = Math.floor((from - tz) / size) * size + tz;
  const count = Math.max(1, Math.ceil((to - start) / size));
  const counts = lists.map((times) => {
    const c = Array.from({ length: count }, () => 0);
    for (const t of times) {
      const i = Math.floor((t - start) / size);
      if (i >= 0 && i < count) c[i]! += 1;
    }
    return c;
  });
  const fmt = new Intl.DateTimeFormat(undefined, size >= 24 * HOUR
    ? { day: 'numeric', month: 'short' }
    : span > 24 * HOUR ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const x = Array.from({ length: count }, (_, i) => fmt.format(new Date(start + i * size)));
  return { x, counts, size };
}

function Activity() {
  const visitors = useVisitors();
  const votes = useVotes();
  const feedback = useFeedback();
  const [range, setRange] = createSignal<'day' | 'all'>('day');
  const data = createMemo(() => {
    const lists = [
      (visitors.data ?? []).map((v) => Date.parse(v.firstSeen)),
      (votes.data ?? []).map((v) => Date.parse(v.createdAt)),
      (feedback.data ?? []).map((f) => Date.parse(f.createdAt)),
    ];
    const now = Date.now();
    const earliest = Math.min(now - HOUR, ...lists.flat());
    return timeline(lists, range() === 'day' ? now - 24 * HOUR : earliest, now);
  });
  const series = () => [
    { label: 'New visitors', color: SERIES[0], values: data().counts[0]! },
    { label: 'Taste-test answers', color: SERIES[1], values: data().counts[1]! },
    { label: 'Ratings', color: SERIES[2], values: data().counts[2]! },
  ];
  const per = () => (data().size >= 24 * HOUR ? (data().size > 24 * HOUR ? 'week' : 'day') : data().size === HOUR ? 'hour' : `${data().size / HOUR} hours`);
  return (
    <Card
      title={`Activity (per ${per()})`}
      class="mt-6"
      actions={<Tabs value={range()} onChange={setRange} options={[{ value: 'day', label: 'Last 24 h' }, { value: 'all', label: 'All time' }]} />}
    >
      <div class="flex flex-col gap-3 p-4">
        <Legend items={series().map((s) => ({ label: s.label, color: s.color, shape: 'line' }))} />
        <LineChart x={data().x} series={series()} title="New visitors, taste-test answers and ratings over time" />
      </div>
    </Card>
  );
}

function TastePreferences() {
  const votes = useVotes();
  const summaries = createMemo(() => EXPERIMENTS.filter((e) => e.taste).map((e) => summarize(e, votes.data ?? [])));
  return (
    <Card title="Taste test: preference share" class="mt-6" actions={<span class="text-xs text-ink-400">from all head-to-head answers</span>}>
      <div class="grid gap-x-6 gap-y-5 p-4 md:grid-cols-2">
        <For each={summaries()}>
          {(s) => {
            const rows = (): BarRow[] =>
              s.rows.map((r) => ({
                key: r.id,
                label: variantLabel(s.experiment.key, r.id),
                value: r.strength,
                display: percent(r.strength),
                color: colorOf(s.experiment, r.id),
                detail: [
                  { label: 'chance it’s the favourite', value: percent(r.best) },
                  { label: 'head-to-heads won', value: `${r.wins} of ${r.games}` },
                ],
              }));
            return (
              <section>
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <h3 class="text-sm font-semibold">{s.experiment.title}</h3>
                  <ConfidenceBadge level={s.confidence} />
                  <span class="text-xs text-ink-400">{s.decided === 1 ? '1 answer' : `${s.decided} answers`}</span>
                </div>
                <BarList rows={rows()} max={Math.max(0.5, ...s.rows.map((r) => r.strength))} empty="No answers yet" />
              </section>
            );
          }}
        </For>
      </div>
    </Card>
  );
}

function VersionsNow() {
  const results = useResults();
  // A split into two is a single ratio, not a pie: only experiments with three or more versions get a donut.
  const exps = () => EXPERIMENTS.filter((e) => e.variants.length >= 3);
  return (
    <Card title="Who is on which version now" class="mt-6" actions={<span class="text-xs text-ink-400">given at random, or picked</span>}>
      <div class="grid gap-6 p-4 md:grid-cols-2 xl:grid-cols-3">
        <For each={exps()}>
          {(e) => {
            const r = () => results.data?.find((x) => x.experiment === e.key);
            const parts = () => e.variants.map((v) => ({ label: v.label, value: r()?.variants.find((x) => x.variant === v.id)?.onItNow ?? 0, color: colorOf(e, v.id) }));
            const total = () => parts().reduce((s, p) => s + p.value, 0);
            return (
              <section>
                <h3 class="mb-2 text-sm font-semibold">{e.title}</h3>
                <Donut parts={parts()} centre={String(total())} centreSub={total() === 1 ? 'visitor' : 'visitors'} />
              </section>
            );
          }}
        </For>
      </div>
    </Card>
  );
}

function FeedbackCharts(props: { items: FeedbackItem[] }) {
  const scores = () => [1, 2, 3, 4, 5].map((n) => ({ label: FACES[n]!, value: props.items.filter((f) => f.rating === n).length, color: SERIES[0], title: `Rated ${n} of 5` }));
  const sources = () => (Object.keys(SOURCES) as FeedbackItem['source'][]).map((s, i) => ({ label: SOURCES[s], value: props.items.filter((f) => f.source === s).length, color: SERIES[i]! }));
  const reasons = createMemo((): BarRow[] => {
    const counts = new Map<string, number>();
    for (const f of props.items) for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => ({ key: t, label: TAGS[t] ?? t, value: n, display: String(n), color: NEGATIVE.has(t) ? SERIES[1] : SERIES[2] }));
  });
  return (
    <div class="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      <Card title="Ratings">
        <div class="p-4">
          <Columns cols={scores()} unit="ratings" />
        </div>
      </Card>
      <Card title="Where the ratings came from">
        <div class="p-4">
          <Donut parts={sources()} centre={String(props.items.length)} centreSub={props.items.length === 1 ? 'rating' : 'ratings'} />
        </div>
      </Card>
      <Card title="Reasons people gave">
        <div class="flex flex-col gap-3 p-4">
          <Legend items={[{ label: 'Liked', color: SERIES[2] }, { label: 'Disliked', color: SERIES[1] }]} />
          <BarList rows={reasons()} empty="No reasons given yet" />
        </div>
      </Card>
    </div>
  );
}

export function AbCharts() {
  const visitors = useVisitors();
  const votes = useVotes();
  const feedback = useFeedback();
  const items = () => feedback.data ?? [];
  const voters = () => new Set((votes.data ?? []).map((v) => v.visitorId)).size;
  const average = () => (items().length ? items().reduce((s, f) => s + f.rating, 0) / items().length : null);
  return (
    <div>
      <ChartTooltip />
      <div class="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Visitors" value={visitors.data?.length ?? '–'} sub={`${visitors.data?.filter((v) => v.registered).length ?? 0} registered`} />
        <StatTile label="Taste-test answers" value={votes.data?.length ?? '–'} sub={`from ${voters()} ${voters() === 1 ? 'person' : 'people'}`} />
        <StatTile label="Ratings" value={items().length} sub={`${items().filter((f) => f.message).length} with a comment`} />
        <StatTile
          label="Average rating"
          value={<Show when={average() != null} fallback="–">{average()!.toFixed(1)} <span class="text-base">{FACES[Math.round(average()!)]}</span></Show>}
          sub="of 5"
        />
      </div>
      <Activity />
      <TastePreferences />
      <VersionsNow />
      <FeedbackCharts items={items()} />
    </div>
  );
}
