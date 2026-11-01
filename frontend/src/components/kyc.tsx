/** KYC status badge texts and the per-check result list, shared by the player and admin screens. */
import { For } from 'solid-js';
import type { KycCheck, KycStatus } from '../api/types';
import { humanize } from '../lib/format';

export const KYC_TONE: Record<KycStatus, 'neutral' | 'warn' | 'win' | 'loss'> = {
  NONE: 'neutral', PENDING: 'warn', VERIFIED: 'win', REJECTED: 'loss',
};

export const KYC_LABEL: Record<KycStatus, string> = {
  NONE: 'Not verified', PENDING: 'Under review', VERIFIED: 'Verified', REJECTED: 'Rejected',
};

const OUTCOME_ICON: Record<KycCheck['outcome'], string> = { PASS: '✓', REVIEW: '?', FAIL: '✕' };
const OUTCOME_CLASS: Record<KycCheck['outcome'], string> = { PASS: 'text-win', REVIEW: 'text-warn', FAIL: 'text-loss' };

export function KycChecks(props: { checks: KycCheck[] }) {
  return (
    <ul class="flex flex-col gap-1.5 text-sm">
      <For each={props.checks}>
        {(c) => (
          <li class="flex items-start gap-2">
            <span class={`w-4 shrink-0 text-center font-bold ${OUTCOME_CLASS[c.outcome]}`} aria-label={c.outcome}>{OUTCOME_ICON[c.outcome]}</span>
            <span>
              <span class="font-medium text-ink-200">{humanize(c.check)}</span>
              <span class="text-ink-400"> · {c.message}</span>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}
