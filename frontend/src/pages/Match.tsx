import { A, useParams } from '@solidjs/router';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createMemo, For, Show } from 'solid-js';
import { get } from '../api/client';
import type { Market, MatchDetail, MatchEventView, MatchState, OddsPoint } from '../api/types';
import { BetSlip } from '../components/BetSlip';
import { Chat } from '../components/Chat';
import { LiveMap } from '../components/LiveMap';
import { RankBadge, Roster } from '../components/live';
import {
  MatchClock,
  NetWorthBar,
  ObjectivePips,
  OddsButton,
  SIDE_COLOR,
  StatusBadge,
  suspendLabel,
  useMatchClock,
} from '../components/match';
import { Badge, Card, Empty, Spinner } from '../components/ui';
import { betslip } from '../lib/betslip';
import { clock, compact, dateTime, humanize, odds } from '../lib/format';
import { TEAM_TEXT, regionLabel, useLiveAssets } from '../lib/live';
import { useTopic } from '../lib/ws';

const TEAM_NAMES = ['Hidden King', 'Archmother'];

function describeEvent(e: MatchEventView): { icon: string; text: string; side?: 1 | 2 } {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'match.discovered':
      return { icon: '◉', text: 'Match picked up by the watcher' };
    case 'objective.destroyed': {
      const lostBy = Number(d.team ?? 0);
      const count = Number(d.count ?? 1);
      return {
        icon: '💥',
        text: `${TEAM_NAMES[1 - lostBy]} destroyed ${count > 1 ? `${count} objectives` : 'an objective'} of ${TEAM_NAMES[lostBy]}`,
        side: (2 - lostBy) as 1 | 2,
      };
    }
    case 'networth.swing': {
      const leader = Number(d.leader ?? 0);
      return { icon: '⚡', text: `${TEAM_NAMES[leader]} swings ahead by ${compact(Number(d.lead ?? 0))} souls`, side: (leader + 1) as 1 | 2 };
    }
    case 'match.stale':
      return { icon: '⏸', text: 'Live data delayed — markets suspended' };
    case 'match.ended':
      return d.winning_team != null
        ? { icon: '🏆', text: `${TEAM_NAMES[Number(d.winning_team)]} win the match`, side: (Number(d.winning_team) + 1) as 1 | 2 }
        : { icon: '🏁', text: 'Match ended — waiting for the official result' };
    default:
      return { icon: '·', text: humanize(e.type) };
  }
}

/** Tiny SVG step chart of every recorded price (odds_history) for one market. */
function OddsChart(props: { market: Market; history: OddsPoint[] }) {
  const series = createMemo(() =>
    props.market.selections.map((s, i) => ({
      name: s.name,
      color: i === 0 ? 'var(--color-amber-team)' : 'var(--color-sapphire-team)',
      points: props.history.filter((h) => h.selectionId === s.id).map((h) => ({ t: new Date(h.recordedAt).getTime(), v: h.odds })),
    })),
  );
  const bounds = createMemo(() => {
    const all = series().flatMap((s) => s.points);
    if (all.length < 2) return null;
    const ts = all.map((p) => p.t);
    const vs = all.map((p) => p.v);
    return { t0: Math.min(...ts), t1: Math.max(...ts, Date.now()), v0: Math.min(...vs) * 0.95, v1: Math.max(...vs) * 1.05 };
  });
  const W = 320;
  const H = 90;
  const path = (pts: { t: number; v: number }[]) => {
    const b = bounds();
    if (!b || pts.length === 0) return '';
    const x = (t: number) => ((t - b.t0) / Math.max(1, b.t1 - b.t0)) * W;
    const y = (v: number) => H - ((v - b.v0) / Math.max(0.01, b.v1 - b.v0)) * H;
    let d = `M${x(pts[0]!.t)},${y(pts[0]!.v)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i]!.t)} V${y(pts[i]!.v)}`;
    return `${d} H${W}`;
  };
  return (
    <Show when={bounds()} fallback={<p class="py-6 text-center text-xs text-ink-500">Odds history appears after the first reprice.</p>}>
      <svg viewBox={`0 0 ${W} ${H}`} class="h-24 w-full" preserveAspectRatio="none" role="img" aria-label={`Odds history for ${props.market.name}`}>
        <For each={series()}>
          {(s) => <path d={path(s.points)} fill="none" stroke={s.color} stroke-width="2" vector-effect="non-scaling-stroke" />}
        </For>
      </svg>
      <div class="mt-1 flex justify-between text-[11px] text-ink-400">
        <For each={series()}>
          {(s) => (
            <span class="flex items-center gap-1">
              <span class="size-2 rounded-full" style={{ background: s.color }} />
              {s.name} {odds(s.points.at(-1)?.v)}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

export default function MatchPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const key = () => ['match', params.id];
  const detail = createQuery(() => ({ queryKey: key(), queryFn: () => get<MatchDetail>(`/api/matches/${params.id}`) }));
  const match = () => detail.data?.match;
  const elapsed = useMatchClock(match);
  const label = () => `Match ${match()?.externalId ?? ''}`;
  const assets = useLiveAssets();
  const teamBadge = (team: 0 | 1) => {
    const b = (match()?.players ?? []).filter((p) => p.team === team && p.badge).map((p) => p.badge!);
    if (!b.length) return null;
    const mean = Math.round(b.map((x) => Math.floor(x / 10) * 6 + (x % 10) - 1).reduce((s, v) => s + v, 0) / b.length);
    return Math.floor(mean / 6) * 10 + (mean % 6) + 1;
  };

  useTopic(
    () => `match:${params.id}`,
    (msg) => {
      const data = msg.data as { markets?: Market[]; eventType?: string; data?: Record<string, unknown>; ts?: string } | undefined;
      if (msg.type === 'ODDS_UPDATED' && data?.markets) {
        queryClient.setQueryData<MatchDetail>(key(), (d) => (d ? { ...d, match: { ...d.match, markets: data.markets! } } : d));
        void queryClient.invalidateQueries({ queryKey: key(), refetchType: 'none' });
      } else if (msg.type === 'MATCH_EVENT' && data?.eventType) {
        const state = data.data?.state as Partial<MatchState> | undefined;
        queryClient.setQueryData<MatchDetail>(key(), (d) => {
          if (!d) return d;
          const next = { ...d, match: { ...d.match, state: state && Object.keys(state).length ? state : d.match.state } };
          if (data.eventType !== 'match.snapshot') {
            next.events = [{ id: msg.seq ?? Date.now(), type: data.eventType!, data: data.data ?? {}, occurredAt: data.ts ?? new Date().toISOString() }, ...d.events];
          }
          return next;
        });
      } else if (msg.type !== 'SUBSCRIBED') {
        void queryClient.invalidateQueries({ queryKey: key() });
      }
    },
  );

  return (
    <Show when={match()} fallback={<div class="grid place-items-center py-24">{detail.isError ? <Empty title="Match not found" /> : <Spinner class="size-8 text-gold-400" />}</div>}>
      {(m) => (
        <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div class="flex min-w-0 flex-col gap-6">
            <A href="/" class="text-sm text-ink-400 hover:text-ink-200">← All live matches</A>

            {/* Scoreboard */}
            <Card class="overflow-hidden">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700/60 px-5 py-3">
                <div class="flex items-center gap-3">
                  <StatusBadge status={m().status} />
                  <span class="text-xs text-ink-400">Deadlock · {regionLabel(m().meta?.region)} · #{m().externalId}</span>
                </div>
                {/* Honest latency badge (Risk #1, F3): public data lags the in-game spectator view. */}
                <Badge tone="neutral" class="normal-case tracking-normal">⏱ Data 20–60 s behind the game</Badge>
              </div>
              <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-6">
                <div>
                  <p class={`text-lg font-extrabold sm:text-2xl ${SIDE_COLOR[1]}`}>Hidden King {m().teams[0]?.isWinner ? '🏆' : ''}</p>
                  <p class="tabular mt-1 text-2xl font-bold sm:text-3xl">{compact(m().state.net_worth?.[0])}</p>
                  <p class="text-xs text-ink-400">souls</p>
                </div>
                <div class="text-center">
                  <MatchClock seconds={elapsed()} />
                  <p class="mt-1 text-[11px] uppercase tracking-wider text-ink-500">game time</p>
                </div>
                <div class="text-right">
                  <p class={`text-lg font-extrabold sm:text-2xl ${SIDE_COLOR[2]}`}>{m().teams[1]?.isWinner ? '🏆 ' : ''}Archmother</p>
                  <p class="tabular mt-1 text-2xl font-bold sm:text-3xl">{compact(m().state.net_worth?.[1])}</p>
                  <p class="text-xs text-ink-400">souls</p>
                </div>
              </div>
              <div class="flex flex-col gap-3 px-5 pb-5">
                <NetWorthBar state={m().state} />
                <div class="grid grid-cols-2 gap-6">
                  <div>
                    <p class="mb-1 text-[11px] uppercase tracking-wider text-ink-400">Objectives standing · {m().state.objectives_alive?.[0] ?? '–'}</p>
                    <ObjectivePips alive={m().state.objectives_alive?.[0] ?? 16} side={1} />
                  </div>
                  <div class="text-right">
                    <p class="mb-1 text-[11px] uppercase tracking-wider text-ink-400">{m().state.objectives_alive?.[1] ?? '–'} · Objectives standing</p>
                    <ObjectivePips alive={m().state.objectives_alive?.[1] ?? 16} side={2} />
                  </div>
                </div>
              </div>
              <Show when={m().status === 'REVIEW'}>
                <p class="bg-warn/10 px-5 py-2 text-sm text-warn">Result under manual review: {humanize(m().reviewReason)}</p>
              </Show>
            </Card>

            {/* Rosters: heroes, Steam names and ranks */}
            <Show when={m().players?.length}>
              <Card title="Teams">
                <div class="grid gap-6 p-4 md:grid-cols-2">
                  {([0, 1] as const).map((team) => (
                    <div>
                      <div class={`mb-2 flex items-center gap-2 ${team === 1 ? 'flex-row-reverse text-right' : ''}`}>
                        <RankBadge assets={assets.data} badge={teamBadge(team)} size="md" />
                        <span class={`font-bold ${TEAM_TEXT[team]}`}>{TEAM_NAMES[team]}</span>
                      </div>
                      <Roster assets={assets.data} players={m().players ?? []} team={team} />
                    </div>
                  ))}
                </div>
              </Card>
            </Show>

            {/* Realtime map (needs a bet on this match, or premium) */}
            <Show when={m().status === 'LIVE' || m().status === 'STALE'}>
              <LiveMap externalId={m().externalId} roster={m().players} />
            </Show>

            {/* Markets */}
            <div class="grid gap-4 md:grid-cols-2">
              <For each={m().markets}>
                {(market) => (
                  <Card
                    title={market.name}
                    actions={<Badge tone={market.status === 'OPEN' ? 'win' : market.status === 'SETTLED' ? 'neutral' : 'warn'}>{humanize(market.status)}</Badge>}
                  >
                    <div class="flex flex-col gap-3 p-4">
                      <div class="flex gap-2">
                        <For each={market.selections}>
                          {(s) => (
                            <OddsButton
                              selection={s}
                              market={market}
                              selected={betslip.pick()?.selection.id === s.id}
                              onPick={(sel, mk) => betslip.setPick({ matchId: m().id, matchLabel: label(), market: mk, selection: sel })}
                            />
                          )}
                        </For>
                      </div>
                      <Show when={market.status === 'SUSPENDED'}>
                        <p class="text-xs text-warn">🔒 {suspendLabel(market.suspendReason)}</p>
                      </Show>
                      <Show when={market.selections.some((s) => s.result)}>
                        <p class="text-xs text-ink-300">
                          Result: {market.selections.filter((s) => s.result === 'WON').map((s) => s.name).join(', ') || 'Void'}
                        </p>
                      </Show>
                      <OddsChart market={market} history={detail.data?.oddsHistory ?? []} />
                    </div>
                  </Card>
                )}
              </For>
            </div>

            {/* Timeline */}
            <Card title="Match timeline">
              <Show when={detail.data?.events.length} fallback={<Empty title="Nothing has happened yet" icon="⌛" />}>
                <ol class="max-h-80 divide-y divide-ink-800 overflow-y-auto">
                  <For each={detail.data?.events}>
                    {(e) => {
                      const d = describeEvent(e);
                      const state = (e.data.state ?? {}) as Partial<MatchState>;
                      return (
                        <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <span class="w-5 text-center">{d.icon}</span>
                          <span class={`flex-1 ${d.side ? SIDE_COLOR[d.side] : 'text-ink-200'}`}>{d.text}</span>
                          <span class="tabular font-mono text-xs text-ink-400" title={dateTime(e.occurredAt)}>
                            {state.elapsed_s != null ? clock(state.elapsed_s) : ''}
                          </span>
                        </li>
                      );
                    }}
                  </For>
                </ol>
              </Show>
            </Card>
          </div>

          <aside class="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
            <BetSlip match={m()} />
            <Chat roomId={m().chatRoomId} title="Match chat" />
          </aside>
        </div>
      )}
    </Show>
  );
}
