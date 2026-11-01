import { A } from '@solidjs/router';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { get } from '../api/client';
import type { Market, Match, MatchState } from '../api/types';
import { BetSlip } from '../components/BetSlip';
import { Chat } from '../components/Chat';
import { NetWorthBar, ObjectivePips, OddsButton, StatusBadge, TeamLine, MatchClock, useMatchClock } from '../components/match';
import { Badge, Card, Empty, PageHeader, Spinner } from '../components/ui';
import { betslip } from '../lib/betslip';
import { humanize } from '../lib/format';
import { hub, useTopic } from '../lib/ws';

function MatchCard(props: { match: Match }) {
  const elapsed = useMatchClock(() => props.match);
  const winner = () => props.match.markets.find((m) => m.marketType === 'match_winner');
  const label = () => `Match ${props.match.externalId}`;
  return (
    <A
      href={`/matches/${props.match.id}`}
      class="group flex flex-col gap-3 rounded-[var(--radius-card)] border border-ink-700/70 bg-ink-900/80 p-4 transition-all hover:-translate-y-0.5 hover:border-ink-500 hover:shadow-[0_12px_40px_-16px_rgb(0_0_0/0.8)]"
    >
      <div class="flex items-center justify-between">
        <StatusBadge status={props.match.status} />
        <div class="flex items-center gap-2 text-xs text-ink-400">
          <MatchClock seconds={elapsed()} />
          <span>· #{props.match.externalId}</span>
        </div>
      </div>
      <div class="flex items-start justify-between gap-2">
        <TeamLine match={props.match} side={1} />
        <span class="pt-1 text-xs font-bold text-ink-500">VS</span>
        <TeamLine match={props.match} side={2} />
      </div>
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

export default function Lobby() {
  const queryClient = useQueryClient();
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
      <div>
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
              <For each={live.data}>{(m) => <MatchCard match={m} />}</For>
            </div>
          </Show>
        </Show>

        <Show when={recent.data?.length}>
          <h2 class="mb-3 mt-10 text-sm font-semibold uppercase tracking-wider text-ink-400">Recently finished</h2>
          <Card>
            <ul class="divide-y divide-ink-800">
              <For each={recent.data}>
                {(m) => (
                  <li>
                    <A href={`/matches/${m.id}`} class="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-ink-850">
                      <span class="text-ink-300">Match #{m.externalId}</span>
                      <span class="text-ink-400">
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
