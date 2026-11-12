import { A } from '@solidjs/router';
import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/solid-query';
import { createMemo, createSignal, For, Index, onMount, Show } from 'solid-js';
import { ApiError, get, post } from '../api/client';
import type { BonusPick, Fairness, Page, SlotGame, SlotRound, SlotState, SpinResult } from '../api/types';
import { toast } from '../components/toast';
import { LINE_SYMBOLS, Paytable, SYMBOL_ART, SymbolIcon, symbolName } from '../components/slotArt';
import { Badge, Button, Card, Empty, Modal, PageHeader } from '../components/ui';
import { auth } from '../lib/auth';
import { ab } from '../lib/experiments';
import { ago, fiat, humanize, tokens } from '../lib/format';
import type { SoundEvent } from '../lib/soundPacks';
import { sounds } from '../lib/sounds';
import { wallet } from '../lib/wallet';
import { useTopic } from '../lib/ws';

const BET_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

/** Wins in a row (the Deadlock pack plays the rising killstreak stingers), kept while moving between pages. */
let winStreak = 0;

/** The sound for a spin's result; a win of 10× the bet or more is a big win. */
function outcomeSound(r: SpinResult, totalBet: number): [SoundEvent, number] {
  winStreak = r.totalWin > 0 ? winStreak + 1 : 0;
  if (r.jackpotWin > 0) return ['jackpot', 0];
  if (r.freeSpinsAwarded > 0) return ['freeSpins', 0];
  if (r.isBonusGameTriggered) return ['bonus', 0];
  if (r.totalWin <= 0) return ['lose', 0];
  if (r.totalWin >= totalBet * 10) return ['bigWin', 0];
  try {
    if (sessionStorage.getItem('naebka.firstWin') !== '1') {
      sessionStorage.setItem('naebka.firstWin', '1');
      return ['firstWin', 0];
    }
  } catch {
    // storage blocked: no "first blood"
  }
  return winStreak >= 2 ? ['streak', winStreak] : ['win', 0];
}

function SlotSymbol(props: { id: string; win?: boolean; spinning?: boolean; delay?: number }) {
  const art = () => SYMBOL_ART[props.id];
  return (
    <div
      class={`relative grid aspect-square place-items-center overflow-hidden rounded-xl border bg-gradient-to-b to-ink-900 transition-all duration-300 ${art()?.tone ?? ''} ${
        props.win ? 'scale-[1.04] border-gold-400 shadow-[0_0_24px_-4px_color-mix(in_oklab,var(--color-gold-500)_80%,transparent)]' : 'border-ink-700'
      }`}
      title={props.spinning ? undefined : art()?.tag}
    >
      <div
        class={`grid size-full place-items-center select-none ${props.spinning ? 'animate-reel opacity-70' : 'animate-pop'} ${art()?.card ? 'p-[9%]' : 'p-[14%]'}`}
        style={{ 'animation-delay': `${props.delay ?? 0}ms` }}
      >
        <SymbolIcon id={props.id} class={`size-full ${art()?.card ? 'rounded-lg' : ''}`} />
      </div>
      <Show when={!props.spinning && art()?.tag}>
        {(tag) => (
          <span class="absolute inset-x-0 bottom-0 bg-ink-950/75 py-px text-center text-[8px] font-black uppercase tracking-wider text-gold-300 sm:text-[10px]">
            {tag()}
          </span>
        )}
      </Show>
    </div>
  );
}

export default function Slots() {
  const queryClient = useQueryClient();
  onMount(() => ab.expose('slot_icons'));
  const game = createQuery(() => ({ queryKey: ['slot-game'], queryFn: async () => (await get<SlotGame[]>('/api/slots/games'))[0]! }));
  const state = createQuery(() => ({ queryKey: ['slot-state'], queryFn: () => get<SlotState>('/api/slots/state'), enabled: !!auth.user() }));
  const jackpot = createQuery(() => ({ queryKey: ['jackpot'], queryFn: () => get<{ amount: number }>('/api/slots/jackpot'), refetchInterval: 15_000 }));

  const [betIdx, setBetIdx] = createSignal(3);
  const [spinning, setSpinning] = createSignal(false);
  const [result, setResult] = createSignal<SpinResult | null>(null);
  const [fakeGrid, setFakeGrid] = createSignal<string[][]>([]);
  const [bonusBoard, setBonusBoard] = createSignal<Record<number, number>>({});
  const [revealed, setRevealed] = createSignal<number[] | null>(null);
  const [fairOpen, setFairOpen] = createSignal(false);

  useTopic(() => 'lobby', (msg) => {
    if (msg.type === 'JACKPOT_WON') void queryClient.invalidateQueries({ queryKey: ['jackpot'] });
  });

  onMount(() => {
    const rnd = () => LINE_SYMBOLS[Math.floor(Math.random() * LINE_SYMBOLS.length)]!;
    setFakeGrid(Array.from({ length: 5 }, () => [rnd(), rnd(), rnd()]));
  });

  const slotState = () => state.data?.state ?? 'IDLE';
  const freeSpins = () => state.data?.freeSpinsRemaining ?? 0;
  const betPerLine = () => BET_STEPS[betIdx()]!;
  const totalBet = () => betPerLine() * (game.data?.paylines.length ?? 10);
  /** Free spins play at the bet that won them, so the paytable shows that one. */
  const paytableBet = () => (slotState() === 'FREE_SPINNING' ? (state.data?.freeSpinBetPerLine ?? betPerLine()) : betPerLine());
  const grid = () => result()?.grid ?? state.data?.lastSpin?.grid ?? fakeGrid();
  const winCells = createMemo(() => {
    const cells = new Set<string>();
    for (const line of result()?.winningLines ?? []) {
      for (let c = 0; c < line.count; c++) cells.add(`${c}:${line.positions[c]}`);
    }
    return cells;
  });

  const spin = async () => {
    if (spinning()) return;
    setSpinning(true);
    setResult(null);
    sounds.play('spin');
    const started = Date.now();
    try {
      const free = slotState() === 'FREE_SPINNING';
      const bet = free ? paytableBet() * (game.data?.paylines.length ?? 10) : totalBet();
      const r = free
        ? await post<SpinResult>('/api/slots/free-spin')
        : await post<SpinResult>('/api/slots/spin', { betPerLine: betPerLine() });
      await new Promise((ok) => setTimeout(ok, Math.max(0, 700 - (Date.now() - started))));
      setResult(r);
      // The reels land one after another (the 60 ms stagger of the tiles), then the result sounds.
      for (let reel = 0; reel < 5; reel++) sounds.play('reelStop', reel, { delay: reel * 0.06 });
      const [event, n] = outcomeSound(r, bet);
      sounds.play(event, n, { delay: 0.34 });
      wallet.set(r.balance);
      ab.track('slot_spin');
      if (r.jackpotWin > 0) toast.success(`JACKPOT! ${tokens(r.jackpotWin)} NTK`);
      else if (r.freeSpinsAwarded > 0) toast.success(`${r.freeSpinsAwarded} free spins!`);
      else if (r.isBonusGameTriggered) toast.success('Rift bonus! Open 3 rifts.');
      setBonusBoard({});
      setRevealed(null);
      void queryClient.invalidateQueries({ queryKey: ['slot-state'] });
      void queryClient.invalidateQueries({ queryKey: ['slot-rounds'] });
      void queryClient.invalidateQueries({ queryKey: ['jackpot'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'GAME_STATE_MISMATCH') void queryClient.invalidateQueries({ queryKey: ['slot-state'] });
      toast.error(e);
    } finally {
      setSpinning(false);
    }
  };

  const pick = async (box: number) => {
    try {
      const r = await post<BonusPick>('/api/slots/bonus/pick', { choice: box });
      setBonusBoard({ ...bonusBoard(), [box]: r.reward });
      sounds.play('bonusPick');
      if (r.completed) {
        sounds.play('bonusEnd', 0, { delay: 0.3 });
        setRevealed(r.revealedBoard);
        wallet.set(r.balance);
        toast.success(`Bonus complete: +${tokens(r.totalBonusWin)} NTK`);
        window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['slot-state'] }), 2500);
      }
    } catch (e) {
      toast.error(e);
      void queryClient.invalidateQueries({ queryKey: ['slot-state'] });
    }
  };

  const opened = () => {
    const fromServer: Record<number, number> = {};
    for (const o of state.data?.bonus?.opened ?? []) fromServer[Number(o.box)] = Number(o.reward);
    return { ...fromServer, ...bonusBoard() };
  };

  return (
    <div>
      <PageHeader
        title="Soul Reels"
        subtitle={
          ab.variant('slot_icons') === 'classic'
            ? 'Classic slots: 5 reels · 10 lines · Joker wilds, Money Bag free spins and the gift bonus. Provably fair.'
            : 'Deadlock slots: 5 reels · 10 lines · Patron wilds, Soul Urn free spins and the rift bonus. Provably fair.'
        }
        actions={
          <div class="rounded-xl border border-gold-500/30 bg-gradient-to-r from-gold-500/15 to-transparent px-4 py-2">
            <p class="text-[11px] font-bold uppercase tracking-widest text-gold-300">Progressive jackpot</p>
            <p class="tabular text-2xl font-black text-gold-300">{tokens(jackpot.data?.amount)} <span class="text-sm">NTK</span></p>
          </div>
        }
      />

      <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card class="p-4 sm:p-6">
          <Show when={slotState() === 'BONUS_GAME' || revealed()}>
            <div class="mb-4 rounded-xl border border-teal-400/30 bg-teal-400/5 p-4">
              <p class="mb-3 text-center font-semibold text-teal-300">
                Rift bonus — {revealed() ? 'complete!' : `open ${state.data?.bonus?.remainingPicks ?? 3} more`} · won {tokens(Object.values(opened()).reduce((a, b) => a + b, 0))}
              </p>
              <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
                <Index each={Array.from({ length: 12 })}>
                  {(_, i) => {
                    const value = () => opened()[i] ?? revealed()?.[i];
                    const mine = () => opened()[i] != null;
                    return (
                      <button
                        data-sound="none"
                        disabled={value() != null || !!revealed()}
                        onClick={() => pick(i)}
                        class={`grid aspect-square place-items-center rounded-lg border text-sm font-bold transition-all ${
                          mine() ? 'border-teal-300 bg-teal-400/20 text-teal-200' : value() != null ? 'border-ink-700 bg-ink-850 text-ink-500' : 'border-ink-600 bg-ink-800 text-2xl hover:-translate-y-0.5 hover:border-teal-300'
                        }`}
                      >
                        {value() != null ? tokens(value()) : <SymbolIcon id="BONUS" class="size-3/5" />}
                      </button>
                    );
                  }}
                </Index>
              </div>
            </div>
          </Show>

          <div class="mx-auto max-w-xl rounded-2xl bg-gradient-to-b from-ink-800 to-ink-950 p-3 ring-1 ring-ink-700 sm:p-4">
            <div class="grid grid-cols-5 gap-2 sm:gap-3">
              <For each={grid()}>
                {(column, c) => (
                  <div class="grid gap-2 sm:gap-3">
                    <For each={column}>
                      {(sym, r) => <SlotSymbol id={sym} spinning={spinning()} delay={c() * 60} win={winCells().has(`${c()}:${r()}`)} />}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="mt-4 flex min-h-12 items-center justify-center">
            <Show
              when={result()}
              fallback={<p class="text-sm text-ink-400">{spinning() ? 'Spinning…' : freeSpins() ? `${freeSpins()} free spins waiting` : 'Good luck!'}</p>}
            >
              {(r) => (
                <Show when={r().totalWin > 0} fallback={<p class="text-sm text-ink-400">No win this time.</p>}>
                  <div class="animate-pop flex flex-col items-center gap-1.5 text-center">
                    <p class="tabular text-3xl font-black text-win">+{tokens(r().totalWin)}</p>
                    <p class="text-xs text-ink-400">≈ {fiat(r().totalWin)}</p>
                    <div class="flex flex-wrap justify-center gap-1.5">
                      <For each={r().winningLines}>
                        {(l) => (
                          <span class="flex items-center gap-1.5 rounded-full bg-ink-850 py-0.5 pl-1 pr-2.5 text-xs ring-1 ring-ink-700">
                            <SymbolIcon id={l.symbol} class="size-5" />
                            <span class="text-ink-300">
                              Line {l.paylineId}: {l.count} × {symbolName(game.data, l.symbol)}
                            </span>
                            <span class="tabular font-semibold text-win">+{tokens(l.win)}</span>
                          </span>
                        )}
                      </For>
                      <Show when={r().scatterCount >= 3}>
                        <span class="flex items-center gap-1.5 rounded-full bg-ink-850 py-0.5 pl-1 pr-2.5 text-xs ring-1 ring-ink-700">
                          <SymbolIcon id="SCATTER" class="size-5" />
                          <span class="text-ink-300">{r().scatterCount} Soul Urns</span>
                        </span>
                      </Show>
                    </div>
                  </div>
                </Show>
              )}
            </Show>
          </div>

          <Show when={auth.user()} fallback={<p class="mt-4 text-center text-sm"><A href="/login" class="font-semibold text-gold-300">Log in</A> to play.</p>}>
            <div class="mt-4 flex flex-wrap items-center justify-center gap-4">
              <Show when={slotState() !== 'FREE_SPINNING'}>
                <div class="flex items-center gap-2 rounded-xl bg-ink-850 p-1.5 ring-1 ring-ink-700">
                  <button class="grid size-9 place-items-center rounded-lg bg-ink-700 font-bold hover:bg-ink-600 disabled:opacity-40" disabled={betIdx() === 0 || spinning()} onClick={() => setBetIdx(betIdx() - 1)} aria-label="Lower bet">−</button>
                  <div class="w-28 text-center">
                    <p class="tabular font-bold">{tokens(totalBet())}</p>
                    <p class="text-[10px] uppercase tracking-wider text-ink-400">{tokens(betPerLine())} × 10 lines</p>
                  </div>
                  <button class="grid size-9 place-items-center rounded-lg bg-ink-700 font-bold hover:bg-ink-600 disabled:opacity-40" disabled={betIdx() === BET_STEPS.length - 1 || spinning()} onClick={() => setBetIdx(betIdx() + 1)} aria-label="Raise bet">+</button>
                </div>
              </Show>
              <Button data-sound="none" size="lg" class="min-w-44 text-lg" loading={spinning()} disabled={slotState() === 'BONUS_GAME'} onClick={spin}>
                {slotState() === 'FREE_SPINNING' ? `Free spin (${freeSpins()})` : 'Spin'}
              </Button>
            </div>
          </Show>
        </Card>

        <aside class="flex flex-col gap-6">
          <Card title="Paytable">
            <Paytable
              game={game.data}
              betPerLine={paytableBet()}
              totalBet={paytableBet() * (game.data?.paylines.length ?? 10)}
              wonLines={new Set((result()?.winningLines ?? []).map((l) => l.paylineId ?? 0))}
            />
          </Card>
          <Show when={auth.user()}>
            <Card title="Provably fair" actions={<Button size="sm" variant="ghost" onClick={() => setFairOpen(true)}>Seeds</Button>}>
              <div class="space-y-2 px-4 py-3 text-xs">
                <p class="text-ink-400">Every spin is HMAC-SHA256(server seed, client seed:nonce). The server seed hash is committed before you play.</p>
                <p class="break-all font-mono text-ink-300">{String(state.data?.fairness?.serverSeedHash ?? '').slice(0, 32)}…</p>
                <p class="text-ink-400">client seed <span class="font-mono text-ink-200">{String(state.data?.fairness?.clientSeed ?? '')}</span> · nonce {String(state.data?.fairness?.nonce ?? 0)}</p>
              </div>
            </Card>
            <RecentRounds />
          </Show>
        </aside>
      </div>
      <FairnessModal open={fairOpen()} onClose={() => setFairOpen(false)} />
    </div>
  );
}

function RecentRounds() {
  const rounds = createInfiniteQuery(() => ({
    queryKey: ['slot-rounds'],
    queryFn: ({ pageParam }) => get<Page<SlotRound>>('/api/slots/rounds', { cursor: pageParam, limit: 8 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  }));
  const [verified, setVerified] = createSignal<Record<string, string>>({});
  const verify = async (id: string) => {
    const r = await get<{ verifiable: boolean; verified?: boolean; reason?: string }>(`/api/slots/rounds/${id}/verify`);
    setVerified({ ...verified(), [id]: r.verifiable ? (r.verified ? '✓ verified' : '✗ MISMATCH') : 'rotate seed first' });
  };
  const all = () => rounds.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Recent rounds">
      <Show when={all().length} fallback={<Empty title="No spins yet" icon="❖" />}>
        <ul class="divide-y divide-ink-800 text-sm">
          <For each={all()}>
            {(r) => (
              <li class="flex items-center justify-between gap-2 px-4 py-2">
                <span class="text-xs text-ink-400">{humanize(r.type)} · {ago(r.createdAt)}</span>
                <span class={`tabular ${r.win > 0 ? 'font-semibold text-win' : 'text-ink-400'}`}>{r.win > 0 ? `+${tokens(r.win)}` : `−${tokens(r.bet)}`}</span>
                <button class="text-[11px] text-gold-300 hover:underline" onClick={() => verify(r.id)}>{verified()[r.id] ?? 'verify'}</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function FairnessModal(props: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [clientSeed, setClientSeed] = createSignal('');
  const [last, setLast] = createSignal<Fairness | null>(null);
  const rotate = async () => {
    try {
      const r = await post<Fairness>('/api/slots/fairness/rotate', { clientSeed: clientSeed() || null });
      setLast(r);
      void queryClient.invalidateQueries({ queryKey: ['slot-state'] });
      toast.success('New seed pair active. Previous server seed revealed.');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal open={props.open} onClose={props.onClose} title="Seed pair" footer={<Button onClick={rotate}>Rotate & reveal</Button>}>
      <div class="flex flex-col gap-3 text-sm">
        <p class="text-ink-400">Rotating reveals your current server seed so you can verify every past spin, then commits to a new one.</p>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-semibold uppercase tracking-wider text-ink-400">New client seed (optional)</span>
          <input class="h-10 rounded-lg border border-ink-600 bg-ink-950/60 px-3 font-mono text-sm" maxLength={64} value={clientSeed()} onInput={(e) => setClientSeed(e.currentTarget.value)} placeholder="random if empty" />
        </label>
        <Show when={last()}>
          {(l) => (
            <div class="space-y-1 rounded-lg bg-ink-850 p-3 font-mono text-[11px] text-ink-300">
              <p>revealed seed: <span class="break-all text-win">{l().previousServerSeed}</span></p>
              <p>its hash: <span class="break-all">{l().previousServerSeedHash}</span></p>
              <p>new hash: <span class="break-all">{l().serverSeedHash}</span></p>
            </div>
          )}
        </Show>
        <Badge tone="neutral" class="self-start normal-case tracking-normal">Check: SHA-256(revealed seed) must equal the hash shown before play</Badge>
      </div>
    </Modal>
  );
}

