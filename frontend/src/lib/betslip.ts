import { createRoot, createSignal } from 'solid-js';
import type { Market, Selection } from '../api/types';

export interface SlipPick {
  matchId: string;
  matchLabel: string;
  market: Market;
  selection: Selection;
}

/** The single-bet slip, shared between the lobby and the match page. */
export const betslip = createRoot(() => {
  const [pick, setPick] = createSignal<SlipPick | null>(null);
  return { pick, setPick, clear: () => setPick(null) };
});
