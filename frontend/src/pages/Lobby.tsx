import { A } from '@solidjs/router';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { get } from '../api/client';
import type { LiveAssets, LiveDirectory, Market, Match, MatchState } from '../api/types';
import { BetSlip } from '../components/BetSlip';
import { Chat } from '../components/Chat';
import { HeroIcon, LiveMatchCard, RankBadge, playerName } from '../components/live';
import { NetWorthBar, ObjectivePips, OddsButton, StatusBadge, TeamLine, MatchClock, useMatchClock } from '../components/match';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Spinner } from '../components/ui';
import { betslip } from '../lib/betslip';
import { ago, humanize } from '../lib/format';
import { MODE_LABEL, TEAM_TEXT, rankOf, regionLabel, useLiveAssets } from '../lib/live';
import { hub, useTopic } from '../lib/ws';

/** A match with markets: odds and both rosters. */
function MatchCard(props: { match: Match; assets?: LiveAssets }) {
  const elapsed = useMatchClock(() => props.match);
  const winner = () => props.match.markets.find((m) => m.marketType === 'match_winner');
  const label = () => `Match ${props.match.externalId}`;
  const team = (t: 0 | 1) => (props.match.players ?? []).filter((p) => p.team === t);
  const avg = (t: 0 | 1) => {
    const b = team(t).map((p) => p.badge).filter((x): x is number => !!x);
    if (!b.length) return null;
    const idx = b.map((x) => Math.floor(x / 10) * 6 + (x % 10) - 1);
    const mean = Math.round(idx.reduce((s, v) => s + v, 0) / idx.length);
    return Math.floor(mean / 6) * 10 + (mean % 6) + 1;
  };
  return (
    <A
      href={`/matches/${props.match.id}`}
      class="group flex flex-col gap-3 rounded-[var(--radius-card)] border border-gold-500/30 bg-ink-900/80 p-4 transition-all hover:-translate-y-0.5 hover:border-gold-500/60 hover:shadow-[0_12px_40px_-16px_rgb(0_0_0/0.8)]"
    >
      <div class="flex items-center justify-between">
        <StatusBadge status={props.match.status} />
        <div class="flex items-center gap-2 text-xs text-ink-400">
          <MatchClock seconds={elapsed()} />
          <span>· {regionLabel(props.match.meta?.region)}</span>
        </div>
      </div>
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-2">
          <RankBadge assets={props.assets} badge={avg(0)} size="md" />
          <TeamLine match={props.match} side={1} />
        </div>
        <span class="pt-1 text-xs font-bold text-ink-500">VS</span>
        <div class="flex items-start gap-2">
          <TeamLine match={props.match} side={2} />
          <RankBadge assets={props.assets} badge={avg(1)} size="md" />
        </div>
      </div>
      <Show when={props.match.players?.length}>
        <div class="grid grid-cols-2 gap-2">
          <div class="flex flex-wrap gap-0.5">
            <For each={team(0)}>{(p) => <HeroIcon assets={props.assets} heroId={p.hero_id} class="size-5 ring-1 ring-amber-team/40" />}</For>
          </div>
          <div class="flex flex-wrap justify-end gap-0.5">
            <For each={team(1)}>{(p) => <HeroIcon assets={props.assets} heroId={p.hero_id} class="size-5 ring-1 ring-sapphire-team/40" />}</For>
          </div>
        </div>
      </Show>
      <NetWorthBar state={props.match.state} />
      <div class="grid grid-cols-2 gap-3">
        <ObjectivePips alive={props.match.state.objectives_alive?.[0] ?? 16} side={1} />
        <ObjectivePips alive={props.match.state.objectives_alive?.[1] ?? 16} side={2} />
      </div>
      <Show when={winner()}>
        {(m) => (
          <div class="flex gap-2">
            <For each={m().selections}>
              {(s) => (
                <OddsButton
                  compact
                  selection={s}
                  market={m()}
                  selected={betslip.pick()?.selection.id === s.id}
                  onPick={(sel, market) => betslip.setPick({ matchId: props.match.id, matchLabel: label(), market, selection: sel })}
                />
              )}
            </For>
          </div>
        )}
      </Show>
    </A>
  );
}

type ModeFilter = 'all' | 'ranked' | 'unranked' | 'street_brawl';

/** Every match in the in-game Watch tab, with filters and the rank spread. */
function AllLiveMatches(props: { assets?: LiveAssets }) {
  const [auto, setAuto] = createSignal(true);
  const directory = createQuery(() => ({
    queryKey: ['live', 'directory'],
    queryFn: () => get<LiveDirectory>('/api/live/directory'),
    refetchInterval: auto() ? 30_000 : false,
  }));
  const [region, setRegion] = createSignal('all');
  const [mode, setMode] = createSignal<ModeFilter>('all');
  const [search, setSearch] = createSignal('');
  const [shown, setShown] = createSignal(24);

  const regions = createMemo(() => [...new Set((directory.data?.matches ?? []).map((m) => m.region).filter((r): r is string => !!r))].sort());
  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    return (directory.data?.matches ?? [])
      .filter((m) => region() === 'all' || m.region === region())
      .filter((m) =>
        mode() === 'all' ? true : mode() === 'street_brawl' ? m.game_mode === 'street_brawl' : m.match_mode === mode() && m.game_mode !== 'street_brawl',
      )
      .filter((m) => !q || m.match_id.includes(q) || m.players.some((p) => playerName(p).toLowerCase().includes(q) || String(p.account_id) === q))
      .sort((a, b) => Number(b.tracked) - Number(a.tracked) || (b.badge ?? 0) - (a.badge ?? 0) || b.spectators - a.spectators);
  });
  const spreadMax = () => Math.max(1, ...(directory.data?.rank_spread ?? []).map((r) => r.matches));

  return (
    <section class="mt-10">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-ink-100">All live matches</h2>
          <p class="text-sm text-ink-400">
            The in-game Watch tab: {directory.data?.total ?? '…'} matches
            <Show when={directory.data?.updated_at}>{(t) => <> · updated {ago(new Date(t() * 1000).toISOString())}</>}</Show>
          </p>
        </div>
      </div>
      <div class="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside class="flex flex-col gap-3 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <div class="flex flex-col gap-3 p-4">
              <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Region
                <Select value={region()} onChange={(e) => setRegion(e.currentTarget.value)}>
                  <option value="all">All regions</option>
                  <For each={regions()}>{(r) => <option value={r}>{regionLabel(r)}</option>}</For>
                </Select>
              </label>
              <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Mode
                <Select value={mode()} onChange={(e) => setMode(e.currentTarget.value as ModeFilter)}>
                  <option value="all">All modes</option>
                  <option value="ranked">{MODE_LABEL.ranked}</option>
                  <option value="unranked">{MODE_LABEL.unranked}</option>
                  <option value="street_brawl">Street Brawl</option>
                </Select>
              </label>
              <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Player or match
                <Input type="search" placeholder="Steam name or id" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
              </label>
              <Button size="sm" variant={auto() ? 'secondary' : 'ghost'} onClick={() => setAuto(!auto())}>
                {auto() ? 'Auto-refresh (30 s) on' : 'Auto-refresh off'}
              </Button>
            </div>
          </Card>
          <Show when={directory.data?.rank_spread.length}>
            <Card title={`Rank spread (${directory.data?.total ?? 0} matches)`}>
              <ul class="flex flex-col gap-1.5 p-4">
                <For each={directory.data?.rank_spread}>
                  {(r) => {
                    const rank = () => rankOf(props.assets, r.tier * 10 + 1);
                    return (
                      <li class="grid grid-cols-[84px_28px_1fr] items-center gap-2 text-xs">
                        <span class="truncate" style={{ color: rank()?.color ?? undefined }}>{rank()?.name ?? `Tier ${r.tier}`}</span>
                        <span class="tabular text-right text-ink-400">{r.matches}</span>
                        <span class="h-2 overflow-hidden rounded bg-ink-800">
                          <span class="block h-full rounded" style={{ width: `${(r.matches / spreadMax()) * 100}%`, background: rank()?.color ?? 'var(--color-gold-500)' }} />
                        </span>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Card>
          </Show>
        </aside>

        <div>
          <Show when={!directory.isLoading} fallback={<div class="grid place-items-center py-16"><Spinner class="size-7 text-gold-400" /></div>}>
            <Show
              when={filtered().length}
              fallback={
                <Card>
                  <Empty title={directory.data?.total ? 'No match fits the filters' : 'The live list is loading'} icon="🔎">
                    {directory.data?.total ? 'Try another region or mode.' : 'The watcher fills it in after its first poll of the Watch tab.'}
                  </Empty>
                </Card>
              }
            >
              <div class="grid gap-4 2xl:grid-cols-2">
                <For each={filtered().slice(0, shown())}>
                  {(m) => <LiveMatchCard match={m} assets={props.assets} bettable={directory.data?.bettable} />}
                </For>
              </div>
              <Show when={filtered().length > shown()}>
                <div class="mt-4 grid place-items-center">
                  <Button variant="secondary" onClick={() => setShown(shown() + 24)}>
                    Show more ({filtered().length - shown()} left)
                  </Button>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </section>
  );
}

export default function Lobby() {
  const queryClient = useQueryClient();
  const assets = useLiveAssets();
  const live = createQuery(() => ({
    queryKey: ['matches', 'live'],
    queryFn: () => get<Match[]>('/api/matches', { status: 'live' }),
    refetchInterval: (q) => (q.state.status === 'error' ? 5_000 : false),
  }));
  const recent = createQuery(() => ({ queryKey: ['matches', 'recent'], queryFn: () => get<Match[]>('/api/matches', { status: 'recent' }) }));

  // Patch prices and scoreboards in place; structural changes trigger a refetch.
  let refetchTimer: number | undefined;
  const refetchSoon = () => {
    window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['matches'] }), 400);
  };
  useTopic(
    () => 'lobby',
    (msg) => {
      const data = msg.data as { matchId?: string; markets?: Market[]; state?: Partial<MatchState> } | undefined;
      switch (msg.type) {
        case 'ODDS_UPDATED':
        case 'MATCH_STATE':
          queryClient.setQueryData<Match[]>(['matches', 'live'], (all) =>
            all?.map((m) =>
              m.id !== data?.matchId
                ? m
                : { ...m, markets: data.markets ?? m.markets, state: data.state && Object.keys(data.state).length ? data.state : m.state },
            ),
          );
          if (msg.type === 'MATCH_STATE' && !live.data?.some((m) => m.id === data?.matchId)) refetchSoon();
          break;
        case 'MARKETS_SUSPENDED':
          queryClient.setQueryData<Match[]>(['matches', 'live'], (all) =>
            all?.map((m) =>
              m.id !== data?.matchId
                ? m
                : { ...m, markets: m.markets.map((mk) => (mk.status === 'OPEN' ? { ...mk, status: 'SUSPENDED', suspendReason: String((msg.data as { reason?: string }).reason) } : mk)) },
            ),
          );
          break;
        case 'SUBSCRIBED':
          break;
        default:
          refetchSoon();
      }
    },
  );

  return (
    <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div class="min-w-0">
        <PageHeader
          title="Live Deadlock"
          subtitle={
            <span class="flex items-center gap-2">
              Real public matches, priced live from the game state.
              <Badge tone={hub.status() === 'open' ? 'win' : 'warn'} pulse>
                {hub.status() === 'open' ? 'Live feed' : 'Connecting'}
              </Badge>
            </span>
          }
        />
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-gold-300">Bet live</h2>
        <Show when={!live.isLoading} fallback={<div class="grid place-items-center py-24"><Spinner class="size-8 text-gold-400" /></div>}>
          <Show
            when={live.data?.length}
            fallback={
              <Card>
                <Show
                  when={!live.isError}
                  fallback={<Empty title="Could not load matches" icon="⚠">The server is unreachable — retrying automatically.</Empty>}
                >
                  <Empty title="No live matches right now" icon="⌛">
                    The watcher picks fresh ranked matches from the Deadlock API every few seconds. Give it a moment.
                  </Empty>
                </Show>
              </Card>
            }
          >
            <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <For each={live.data}>{(m) => <MatchCard match={m} assets={assets.data} />}</For>
            </div>
          </Show>
        </Show>

        <AllLiveMatches assets={assets.data} />

        <Show when={recent.data?.length}>
          <h2 class="mb-3 mt-10 text-sm font-semibold uppercase tracking-wider text-ink-400">Recently finished</h2>
          <Card>
            <ul class="divide-y divide-ink-800">
              <For each={recent.data}>
                {(m) => (
                  <li>
                    <A href={`/matches/${m.id}`} class="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-ink-850">
                      <span class="text-ink-300">Match #{m.externalId}</span>
                      <span class={m.teams.find((t) => t.isWinner) ? TEAM_TEXT[(m.teams.find((t) => t.isWinner)?.side ?? 1) - 1 as 0 | 1] : 'text-ink-400'}>
                        {m.teams.find((t) => t.isWinner)?.name ? `${m.teams.find((t) => t.isWinner)?.name} won` : humanize(m.reviewReason) || 'Awaiting result'}
                      </span>
                      <StatusBadge status={m.status} />
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Card>
        </Show>
      </div>

      <aside class="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
        <BetSlip match={live.data?.find((m) => m.id === betslip.pick()?.matchId)} />
        <GlobalChat />
      </aside>
    </div>
  );
}

function GlobalChat() {
  const rooms = createQuery(() => ({ queryKey: ['chat', 'rooms'], queryFn: () => get<{ id: string; name: string }[]>('/api/chat/rooms') }));
  return <Chat roomId={rooms.data?.[0]?.id} title="Global chat" />;
}
