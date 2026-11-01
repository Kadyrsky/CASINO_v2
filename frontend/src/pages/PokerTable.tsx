import { A, useParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from 'solid-js';
import { ApiError, get, post } from '../api/client';
import type { PokerPrivateState, PokerPublicState, PokerSeat } from '../api/types';
import { PlayingCard } from '../components/PlayingCard';
import { toast } from '../components/toast';
import { Badge, Button, Field, Input, Modal, Spinner } from '../components/ui';
import { auth } from '../lib/auth';
import { chips, humanize, tokens } from '../lib/format';
import { wallet } from '../lib/wallet';
import { hub, useHubMessages, useTopic } from '../lib/ws';

interface ActionLog {
  id: number;
  text: string;
}

export default function PokerTablePage() {
  const params = useParams();
  const [table, setTable] = createSignal<PokerPublicState | null>(null);
  const [me, setMe] = createSignal<PokerPrivateState | null>(null);
  const [log, setLog] = createSignal<ActionLog[]>([]);
  const [sitSeat, setSitSeat] = createSignal<number | null>(null);
  const [buyIn, setBuyIn] = createSignal('');
  const [raiseTo, setRaiseTo] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);

  const load = async () => {
    const path = auth.user() ? `/api/poker/tables/${params.id}/me` : `/api/poker/tables/${params.id}`;
    const s = await get<{ table: PokerPublicState; me?: PokerPrivateState }>(path);
    setTable(s.table);
    setMe(s.me ?? null);
  };
  createEffect(on(() => [params.id, auth.user()?.id], () => void load().catch(toast.error)));

  const timer = window.setInterval(() => setNow(Date.now()), 250);
  onCleanup(() => window.clearInterval(timer));

  useTopic(
    () => `poker:${params.id}`,
    (msg) => {
      if (msg.type === 'POKER_STATE') setTable(msg.data as PokerPublicState);
      if (msg.type === 'POKER_ACTION') {
        const a = msg.data as { username: string; action: string; amount: number };
        const amount = ['BET', 'RAISE'].includes(a.action) ? ` to ${chips(a.amount)}` : '';
        setLog((l) => [{ id: msg.seq ?? Date.now(), text: `${a.username} ${humanize(a.action).toLowerCase()}${amount}` }, ...l].slice(0, 30));
      }
      if (msg.type === 'POKER_HAND_COMPLETE') {
        const r = msg.data as { handNumber: number; winnings: Record<string, number>; rake: number };
        const names = Object.entries(r.winnings).map(([id, amt]) => `${nameOf(id)} wins ${chips(amt)}`);
        setLog((l) => [{ id: Date.now(), text: `Hand #${r.handNumber}: ${names.join(', ')}` }, ...l].slice(0, 30));
      }
    },
  );
  useTopic(
    () => (auth.user() ? `user:${auth.user()!.id}` : null),
    (msg) => {
      if (msg.type === 'POKER_PRIVATE' && (msg.data as PokerPrivateState).tableId === params.id) setMe(msg.data as PokerPrivateState);
      if (msg.type === 'POKER_LEFT') toast.info(`You left the table. ${tokens((msg.data as { cashedOut: number }).cashedOut)} NTK returned to your wallet.`);
    },
  );
  useHubMessages((msg) => {
    if (msg.type === 'ERROR') toast.error(String(msg.message));
    if (msg.type === 'SYNC_GAME_STATE' && msg.topic === `poker:${params.id}`) {
      const d = msg.data as { table: PokerPublicState; me?: PokerPrivateState };
      setTable(d.table);
      if (d.me) setMe(d.me);
    }
  });

  const nameOf = (userId: string) => table()?.seats.find((s) => s.userId === userId)?.username ?? 'Player';
  const seated = () => !!me()?.seated;
  const legal = () => me()?.legalActions;
  const mySeat = () => me()?.seatNo ?? 0;

  // Rotate the table so the viewer always sits at the bottom.
  const seatPos = (seatNo: number) => {
    const n = table()?.maxSeats ?? 6;
    const angle = Math.PI / 2 + ((seatNo - (seated() ? mySeat() : 0)) * 2 * Math.PI) / n;
    return { left: `${50 + 44 * Math.cos(angle)}%`, top: `${50 + 40 * Math.sin(angle)}%` };
  };
  const secondsLeft = () => {
    const d = table()?.turnDeadline;
    return d ? Math.max(0, Math.ceil((new Date(d).getTime() - now()) / 1000)) : null;
  };
  createEffect(on(() => legal()?.minRaiseTo, (min) => min != null && setRaiseTo(min)));

  const shownCards = createMemo(() => (table()?.handInProgress ? {} : (table()?.lastResult?.shown ?? {})));

  const act = (action: string, amount = 0) => {
    if (!hub.send({ op: 'poker.action', tableId: params.id, action, amount })) toast.error('Not connected — reconnecting…');
  };

  const sit = async () => {
    const seat = sitSeat();
    if (seat == null) return;
    setBusy(true);
    try {
      const priv = await post<PokerPrivateState>(`/api/poker/tables/${params.id}/sit`, { seatNo: seat, buyInTokens: Number(buyIn()) });
      setMe(priv);
      setSitSeat(null);
      void wallet.refresh();
      toast.success('You are seated. The next hand starts when two players are ready.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    try {
      const r = await post<{ left: boolean; message: string }>(`/api/poker/tables/${params.id}/leave`);
      if (r.left) setMe({ tableId: params.id!, seated: false });
      toast.info(r.message);
      void wallet.refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleSitOut = async () => {
    try {
      await post(`/api/poker/tables/${params.id}/${me()?.sittingOut ? 'sit-in' : 'sit-out'}`);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e : String(e));
    }
  };

  return (
    <Show when={table()} fallback={<div class="grid place-items-center py-24"><Spinner class="size-8" /></div>}>
      {(t) => (
        <div class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <A href="/poker" class="text-sm text-ink-400 hover:text-ink-200">← Tables</A>
              <h1 class="text-2xl font-extrabold">{t().name}</h1>
              <p class="tabular text-sm text-ink-400">Blinds {chips(t().smallBlind)} / {chips(t().bigBlind)} · hand #{t().handNumber}</p>
            </div>
            <Show when={seated()}>
              <div class="flex gap-2">
                <Button variant="secondary" size="sm" onClick={toggleSitOut}>{me()?.sittingOut ? 'Sit back in' : 'Sit out next hand'}</Button>
                <Button variant="ghost" size="sm" onClick={leave}>Leave table</Button>
              </div>
            </Show>
          </div>

          <div class="grid gap-4 lg:grid-cols-[1fr_280px]">
            {/* Felt */}
            <div class="relative mx-auto aspect-[16/11] w-full" style={{ 'max-width': 'min(56rem, calc(66vh * 16 / 11))' }}>
              <div class="absolute inset-[9%] rounded-[45%] border-[10px] border-[#3b2412] bg-[radial-gradient(ellipse_at_center,var(--color-felt-700),var(--color-felt-800))] shadow-[inset_0_0_60px_rgb(0_0_0/0.6),0_20px_60px_-20px_rgb(0_0_0/0.9)]" />
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div class="flex gap-1.5">
                  <For each={t().board}>{(c) => <PlayingCard card={c} />}</For>
                  <For each={Array.from({ length: Math.max(0, 5 - t().board.length) })}>
                    {() => <div class="h-16 w-11 rounded-md border border-dashed border-white/15" />}
                  </For>
                </div>
                <Show when={t().pot > 0}>
                  <div class="tabular rounded-full bg-black/40 px-4 py-1 text-sm font-bold text-gold-300">Pot {chips(t().pot)}</div>
                </Show>
                <Show when={!t().handInProgress}>
                  <p class="rounded-full bg-black/30 px-3 py-1 text-xs text-ink-200">
                    {t().seats.filter((s) => s.userId && !s.sittingOut).length < 2 ? 'Waiting for players…' : 'Next hand starting…'}
                  </p>
                </Show>
              </div>

              <Index each={t().seats}>
                {(seat) => (
                  <div class="absolute -translate-x-1/2 -translate-y-1/2" style={seatPos(seat().seatNo)}>
                    <SeatView
                      seat={seat()}
                      isMe={seated() && seat().seatNo === mySeat()}
                      myCards={me()?.holeCards ?? []}
                      isTurn={t().handInProgress && t().turnSeat === seat().seatNo}
                      isDealer={t().dealerSeat === seat().seatNo && !!seat().userId}
                      secondsLeft={secondsLeft()}
                      shown={seat().userId ? shownCards()[seat().userId!]?.cards : undefined}
                      handRank={seat().userId ? shownCards()[seat().userId!]?.handRank : undefined}
                      won={seat().userId ? t().lastResult?.winnings?.[seat().userId!] : undefined}
                      canSit={!seated() && !!auth.user()}
                      onSit={() => {
                        setBuyIn(String((t().bigBlind * 50) / 100));
                        setSitSeat(seat().seatNo);
                      }}
                    />
                  </div>
                )}
              </Index>
            </div>

            <aside class="flex flex-col gap-3">
              <div class="rounded-[var(--radius-card)] border border-ink-700/70 bg-ink-900/80">
                <p class="border-b border-ink-700/60 px-4 py-2.5 text-sm font-semibold text-ink-200">Table log</p>
                <ul class="max-h-72 space-y-1 overflow-y-auto px-4 py-2 text-xs text-ink-300">
                  <For each={log()} fallback={<li class="text-ink-500">Actions appear here.</li>}>{(l) => <li>{l.text}</li>}</For>
                </ul>
              </div>
              <Show when={!auth.user()}>
                <p class="text-center text-sm text-ink-400"><A href="/login" class="text-gold-300">Log in</A> to take a seat.</p>
              </Show>
            </aside>
          </div>

          {/* Action bar */}
          <Show when={legal()}>
            {(l) => (
              <div class="sticky bottom-3 z-30 mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-gold-500/40 bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
                <Badge tone="gold" pulse>Your turn · {secondsLeft() ?? '–'}s</Badge>
                <Button variant="danger" onClick={() => act('FOLD')}>Fold</Button>
                <Show when={l().canCheck} fallback={<Button variant="secondary" onClick={() => act('CALL')}>Call {chips(l().toCall)}</Button>}>
                  <Button variant="secondary" onClick={() => act('CHECK')}>Check</Button>
                </Show>
                <Show when={l().canRaise}>
                  <div class="flex flex-1 items-center gap-2">
                    <input
                      type="range"
                      class="flex-1 accent-gold-500"
                      min={l().minRaiseTo}
                      max={l().maxRaiseTo}
                      step={Math.max(1, t().smallBlind)}
                      value={raiseTo()}
                      onInput={(e) => setRaiseTo(Number(e.currentTarget.value))}
                      aria-label="Raise amount"
                    />
                    <Button onClick={() => act(raiseTo() >= l().maxRaiseTo ? 'ALL_IN' : l().raiseType, raiseTo())}>
                      {raiseTo() >= l().maxRaiseTo ? 'All-in' : humanize(l().raiseType)} {chips(raiseTo())}
                    </Button>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Modal
            open={sitSeat() != null}
            onClose={() => setSitSeat(null)}
            title={`Sit at seat ${(sitSeat() ?? 0) + 1}`}
            footer={<><Button variant="ghost" onClick={() => setSitSeat(null)}>Cancel</Button><Button loading={busy()} onClick={sit}>Buy in</Button></>}
          >
            <Field label="Buy-in (NTK)" hint={`Between ${chips(t().bigBlind * 20)} and ${chips(t().bigBlind * 100)} · balance ${tokens(wallet.balance())}`}>
              <Input type="number" step="0.01" value={buyIn()} onInput={(e) => setBuyIn(e.currentTarget.value)} />
            </Field>
            <p class="mt-3 text-xs text-ink-400">Chips move from your wallet to the table and back when you leave.</p>
          </Modal>
        </div>
      )}
    </Show>
  );
}

function SeatView(props: {
  seat: PokerSeat;
  isMe: boolean;
  myCards: string[];
  isTurn: boolean;
  isDealer: boolean;
  secondsLeft: number | null;
  shown?: string[];
  handRank?: string;
  won?: number;
  canSit: boolean;
  onSit: () => void;
}) {
  const cards = () => (props.isMe && props.myCards.length ? props.myCards : props.shown ?? props.seat.cards ?? []);
  return (
    <Show
      when={props.seat.userId}
      fallback={
        <Show when={props.canSit} fallback={<div class="size-12 rounded-full border border-dashed border-white/10" />}>
          <button class="grid size-14 place-items-center rounded-full border border-dashed border-gold-500/50 bg-black/30 text-xs font-semibold text-gold-300 hover:bg-gold-500/10" onClick={props.onSit}>
            Sit
          </button>
        </Show>
      }
    >
      <div class={`flex flex-col items-center gap-1 ${props.seat.status === 'FOLDED' && props.seat.inHand !== false ? 'opacity-50' : ''}`}>
        <div class="flex -space-x-3">
          <For each={cards()}>{(c) => <PlayingCard card={c} size={props.isMe ? 'md' : 'sm'} />}</For>
        </div>
        <div
          class={`relative min-w-24 rounded-xl border px-3 py-1.5 text-center shadow-lg ${
            props.isTurn ? 'border-gold-400 bg-ink-800 ring-2 ring-gold-400/50' : props.isMe ? 'border-gold-600/50 bg-ink-850' : 'border-ink-600 bg-ink-900/95'
          }`}
        >
          <Show when={props.isDealer}>
            <span class="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full bg-ink-100 text-[10px] font-black text-ink-950">D</span>
          </Show>
          <p class="max-w-24 truncate text-xs font-semibold">{props.seat.username}{props.seat.connected === false ? ' ⚠' : ''}</p>
          <p class="tabular text-sm font-bold text-gold-300">{chips(props.seat.stack)}</p>
          <Show when={props.isTurn && props.secondsLeft != null}>
            <div class="mt-1 h-0.5 overflow-hidden rounded-full bg-ink-700">
              <div class="h-full bg-gold-400 transition-[width] duration-200" style={{ width: `${Math.min(100, ((props.secondsLeft ?? 0) / 30) * 100)}%` }} />
            </div>
          </Show>
          <Show when={props.seat.sittingOut}><p class="text-[10px] text-ink-400">sitting out</p></Show>
          <Show when={props.seat.status === 'ALL_IN' && props.seat.inHand}><p class="text-[10px] font-bold text-loss">ALL-IN</p></Show>
        </div>
        <Show when={(props.seat.currentBet ?? 0) > 0}>
          <span class="tabular rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-semibold text-gold-200">{chips(props.seat.currentBet)}</span>
        </Show>
        <Show when={props.won}>
          <span class="animate-pop rounded-full bg-win px-2 py-0.5 text-[11px] font-bold text-ink-950">+{chips(props.won)}</span>
        </Show>
        <Show when={props.handRank}>
          <span class="text-[10px] capitalize text-ink-200">{props.handRank}</span>
        </Show>
      </div>
    </Show>
  );
}
