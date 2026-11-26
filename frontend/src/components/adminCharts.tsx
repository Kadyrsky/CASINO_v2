/**
 * The admin dashboard's Charts view: the same data as the Tables view (adminAb.tsx), drawn so the state of the test
 * is visible at a glance. Activity over time, the taste-test preferences, who is on which version, and what the
 * ratings and reasons say. The Tables view keeps every exact figure and the CSV exports.
 */
import { createMemo, createSignal, For, Show } from 'solid-js';
import { EXPERIMENTS, variantLabel, type Experiment } from '../lib/experiments';
import { musicPack } from '../lib/musicPacks';
import { ChartTooltip, Columns, Donut, LineChart, Legend, SERIES, StatTile, BarList, type BarRow } from './charts';
import { ConfidenceBadge, FACES, SOURCES, summarize, useFeedback, useResults, useVisitors, useVotes, type FeedbackItem, type TasteSummary } from './adminAb';
import { TAGS } from './QuickRating';
import { Card, Tabs } from './ui';

const HOUR = 3_600_000;
const SIZES = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * 24 * HOUR];
const NEGATIVE = new Set(['hard_to_read', 'too_dark', 'music_annoying', 'sounds_annoying', 'confusing', 'slow_buggy']);

/**
 * A version keeps its colour everywhere: its place in the experiment's list. An experiment with more versions than
 * there are colours (the ten music packs) gets one hue, shown as ranked bars that name each version: cycling the
 * colours would paint two versions the same.
 */
const colorOf = (e: Experiment, id: string) =>
  e.variants.length > SERIES.length ? SERIES[0] : SERIES[Math.max(0, e.variants.findIndex((v) => v.id === id)) % SERIES.length]!;
/** The music packs' versions: one experiment per pack with several. */
const versionExperiments = () => EXPERIMENTS.filter((e) => e.parent?.key === 'music_pack');
const packTitle = (e: Experiment) => musicPack(e.parent?.variant ?? '')?.title ?? e.title;
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

/** One experiment's preference shares as ranked bars. */
function Preferences(props: { summary: TasteSummary; title: string }) {
  const s = () => props.summary;
  const rows = (): BarRow[] =>
    s().rows.map((r) => ({
      key: r.id,
      label: variantLabel(s().experiment.key, r.id),
      value: r.strength,
      display: percent(r.strength),
      color: colorOf(s().experiment, r.id),
      detail: [
        { label: 'chance it’s the favourite', value: percent(r.best) },
        { label: 'head-to-heads won', value: `${r.wins} of ${r.games}` },
      ],
    }));
  return (
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold">{props.title}</h3>
        <ConfidenceBadge level={s().confidence} />
        <span class="text-xs text-ink-400">{s().decided === 1 ? '1 answer' : `${s().decided} answers`}</span>
      </div>
      <BarList rows={rows()} max={Math.max(0.5, ...s().rows.map((r) => r.strength))} empty="No answers yet" />
    </section>
  );
}

function TastePreferences() {
  const votes = useVotes();
  const summaries = createMemo(() => EXPERIMENTS.filter((e) => e.taste && !e.parent).map((e) => summarize(e, votes.data ?? [])));
  const versions = createMemo(() => versionExperiments().map((e) => summarize(e, votes.data ?? [])));
  return (
    <Card title="Taste test: preference share" class="mt-6" actions={<span class="text-xs text-ink-400">from all head-to-head answers</span>}>
      <div class="grid gap-x-6 gap-y-5 p-4 md:grid-cols-2">
        <For each={summaries()}>{(s) => <Preferences summary={s} title={s.experiment.title} />}</For>
      </div>
      <div class="border-t border-ink-800 p-4">
        <h3 class="text-sm font-semibold">Music: which version of each pack</h3>
        <p class="mb-3 text-xs text-ink-400">Asked right after the music question, about the pack the person picked.</p>
        <div class="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          <For each={versions()}>{(s) => <Preferences summary={s} title={packTitle(s.experiment)} />}</For>
        </div>
      </div>
    </Card>
  );
}

function VersionsNow() {
  const results = useResults();
  const onIt = (e: Experiment) => {
    const r = results.data?.find((x) => x.experiment === e.key);
    return e.variants.map((v) => ({ id: v.id, label: v.label, value: r?.variants.find((x) => x.variant === v.id)?.onItNow ?? 0 }));
  };
  /** Bars, ranked for the ten packs, in list order for a pack's few versions; the share is in the tooltip. */
  const bars = (e: Experiment, ranked: boolean): BarRow[] => {
    const parts = onIt(e);
    const total = parts.reduce((s, p) => s + p.value, 0);
    const rows = parts.map((p) => ({
      key: p.id,
      label: p.label,
      value: p.value,
      display: String(p.value),
      color: colorOf(e, p.id),
      detail: [{ label: `of ${total}`, value: total ? percent(p.value / total) : '–' }],
    }));
    return ranked ? rows.sort((a, b) => b.value - a.value) : rows;
  };
  // A split into two is a single ratio, not a pie: only experiments with three or more versions get a chart here. A
  // donut for a few versions; ranked bars when there are too many for a donut (the ten music packs).
  const exps = () => EXPERIMENTS.filter((e) => e.variants.length >= 3 && !e.parent);
  const many = (e: Experiment) => e.variants.length > SERIES.length;
  return (
    <Card title="Who is on which version now" class="mt-6" actions={<span class="text-xs text-ink-400">given at random, or picked</span>}>
      <div class="grid gap-6 p-4 md:grid-cols-2 xl:grid-cols-3">
        <For each={exps()}>
          {(e) => {
            const total = () => onIt(e).reduce((s, p) => s + p.value, 0);
            return (
              <section>
                <h3 class="mb-2 text-sm font-semibold">
                  {e.title}
                  <Show when={many(e)}>
                    <span class="ml-2 text-xs font-normal text-ink-400">{total() === 1 ? '1 visitor' : `${total()} visitors`}</span>
                  </Show>
                </h3>
                <Show
                  when={many(e)}
                  fallback={
                    <Donut
                      parts={onIt(e).map((p) => ({ label: p.label, value: p.value, color: colorOf(e, p.id) }))}
                      centre={String(total())}
                      centreSub={total() === 1 ? 'visitor' : 'visitors'}
                    />
                  }
                >
                  <BarList rows={bars(e, true)} />
                </Show>
              </section>
            );
          }}
        </For>
      </div>
      <div class="border-t border-ink-800 p-4">
        <h3 class="text-sm font-semibold">Music: the version within each pack</h3>
        <p class="mb-3 text-xs text-ink-400">Everyone is given a version of every pack; counted here once they’ve heard that pack.</p>
        <div class="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          <For each={versionExperiments()}>
            {(e) => (
              <section>
                <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">{packTitle(e)}</h4>
                <BarList rows={bars(e, false)} />
              </section>
            )}
          </For>
        </div>
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
