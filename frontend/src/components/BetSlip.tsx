import { A } from '@solidjs/router';
import { useQueryClient } from '@tanstack/solid-query';
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { ApiError, newIdempotencyKey, post } from '../api/client';
import type { Bet, Match } from '../api/types';
import { auth } from '../lib/auth';
import { betslip } from '../lib/betslip';
import { appConfig, fiat, odds, tokens } from '../lib/format';
import { wallet } from '../lib/wallet';
import { suspendLabel } from './match';
import { toast } from './toast';
import { Button, Card, Input } from './ui';

const QUICK = [5, 10, 25, 100];

/**
 * Bet slip. Sends selection + stake + the price the user saw. If the price moved, the server answers
 * 409 PRICE_CHANGED and the slip asks the user to accept the new odds (Technical Design: reconfirmation).
 */
export function BetSlip(props: { match?: Match }) {
  const queryClient = useQueryClient();
  const [stake, setStake] = createSignal('10');
  const [busy, setBusy] = createSignal(false);
  const [acceptHigher, setAcceptHigher] = createSignal(true);
  const [notice, setNotice] = createSignal<{ tone: 'warn' | 'error'; text: string } | null>(null);
  // One key per attempt, reused if the same attempt is retried after a network error.
  let idempotencyKey = newIdempotencyKey();

  // Keep the picked selection in sync with live prices of the open match.
  const live = createMemo(() => {
    const p = betslip.pick();
    if (!p) return null;
    const market = props.match?.id === p.matchId ? props.match.markets.find((m) => m.id === p.market.id) : undefined;
    const selection = market?.selections.find((s) => s.id === p.selection.id);
    return { ...p, market: market ?? p.market, selection: selection ?? p.selection };
  });
  const [seenOdds, setSeenOdds] = createSignal<number | null>(null);
  createEffect(on(() => betslip.pick()?.selection.id, () => {
    setSeenOdds(betslip.pick()?.selection.odds ?? null);
    setNotice(null);
    idempotencyKey = newIdempotencyKey();
  }));

  const stakeNum = () => Number(stake()) || 0;
  // A higher price is fine when the user opted in; any drop needs an explicit accept.
  const priceMoved = () => {
    const now = live()?.selection.odds;
    const seen = seenOdds();
    return now != null && seen != null && (acceptHigher() ? now < seen : now !== seen);
  };
  const payout = () => stakeNum() * (seenOdds() ?? 0);
  const open = () => live()?.market.status === 'OPEN';
  const cfg = appConfig;

  const place = async () => {
    const p = live();
    if (!p || seenOdds() == null) return;
    setBusy(true);
    setNotice(null);
    try {
      const bet = await post<Bet>('/api/bets', { selectionId: p.selection.id, stakeTokens: stakeNum(), expectedOdds: seenOdds(), acceptHigherOdds: acceptHigher() }, idempotencyKey);
      toast.success(`Bet placed: ${tokens(bet.stake)} on ${bet.selectionName} @ ${odds(bet.odds)}`);
      setSeenOdds(bet.odds);
      idempotencyKey = newIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: ['bets'] });
      void wallet.refresh();
    } catch (e) {
      idempotencyKey = newIdempotencyKey();
      if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
        const current = e.extra.currentOdds as number | undefined;
        setNotice({ tone: 'warn', text: `The price moved to ${odds(current)}. Review and confirm the new odds.` });
        if (current != null && p.selection.odds == null) setSeenOdds(current);
      } else if (e instanceof ApiError && e.code === 'MARKET_SUSPENDED') {
        setNotice({ tone: 'warn', text: 'Market suspended while odds are recalculated. Try again in a moment.' });
      } else if (e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS') {
        setNotice({ tone: 'error', text: 'Not enough tokens. Top up your wallet to place this bet.' });
      } else {
        setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Bet failed' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Bet slip" actions={<Show when={betslip.pick()}><button class="text-xs text-ink-400 hover:text-ink-200" onClick={betslip.clear}>Clear</button></Show>}>
      <Show
        when={live()}
        fallback={<p class="px-4 py-8 text-center text-sm text-ink-400">Pick a price to start a bet.</p>}
      >
        {(p) => (
          <div class="flex flex-col gap-4 p-4">
            <div>
              <p class="text-xs text-ink-400">{p().matchLabel} · {p().market.name}</p>
              <div class="mt-1 flex items-center justify-between">
                <span class="font-semibold">{p().selection.name}</span>
                <span class="tabular text-lg font-bold text-gold-300">{odds(seenOdds())}</span>
              </div>
            </div>

            <Show when={!open()}>
              <p class="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">🔒 {suspendLabel(p().market.suspendReason)}</p>
            </Show>

            <Show when={auth.user()} fallback={<A href="/login" class="text-center text-sm font-semibold text-gold-300">Log in to bet</A>}>
              <div>
                <Input
                  type="number"
                  inputmode="decimal"
                  min={cfg()?.minStakeTokens ?? 1}
                  max={cfg()?.maxStakeTokens ?? 5000}
                  step="0.01"
                  value={stake()}
                  onInput={(e) => setStake(e.currentTarget.value)}
                  aria-label="Stake in tokens"
                />
                <div class="mt-2 flex gap-1.5">
                  <For each={QUICK}>
                    {(q) => (
                      <button class="flex-1 rounded-md bg-ink-800 py-1 text-xs font-semibold text-ink-300 hover:bg-ink-700" onClick={() => setStake(String(q))}>
                        {q}
                      </button>
                    )}
                  </For>
                </div>
                <p class="mt-2 text-xs text-ink-400">
                  Balance {tokens(wallet.balance())} · stake {cfg()?.minStakeTokens ?? 1}–{tokens(cfg()?.maxStakeTokens ?? 5000)}
                </p>
              </div>

              <div class="flex items-end justify-between rounded-lg bg-ink-850 px-3 py-2">
                <span class="text-xs text-ink-400">Potential payout</span>
                <span class="text-right">
                  <span class="tabular block text-base font-bold text-win">{fiat(payout())}</span>
                  <span class="tabular block text-[11px] text-ink-400">{tokens(payout())} NTK</span>
                </span>
              </div>

              <Show when={priceMoved()}>
                <div class="flex items-center justify-between gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                  <span>Odds changed {odds(seenOdds())} → {odds(p().selection.odds)}</span>
                  <button class="font-bold underline" onClick={() => { setSeenOdds(p().selection.odds); setNotice(null); }}>
                    Accept
                  </button>
                </div>
              </Show>
              <Show when={notice()}>
                {(n) => <p role="alert" class={`rounded-lg px-3 py-2 text-xs ${n().tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-loss/10 text-loss'}`}>{n().text}</p>}
              </Show>

              <label class="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" class="accent-gold-500" checked={acceptHigher()} onChange={(e) => setAcceptHigher(e.currentTarget.checked)} />
                Accept higher odds automatically
              </label>
              <Button size="lg" loading={busy()} disabled={!open() || priceMoved() || stakeNum() <= 0} onClick={place}>
                Place bet · {tokens(stakeNum())}
              </Button>
              <p class="text-center text-[11px] leading-snug text-ink-500">
                Bets are confirmed after a short safety delay. If the price changes meanwhile you will be asked to confirm again.
              </p>
            </Show>
          </div>
        )}
      </Show>
    </Card>
  );
}
