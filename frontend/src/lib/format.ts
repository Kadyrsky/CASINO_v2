import { createRoot, createResource } from 'solid-js';
import { get } from '../api/client';
import type { AppConfig } from '../api/types';

export const appConfig = createRoot(() => {
  const [config] = createResource(() => get<AppConfig>('/api/config'));
  return config;
});

const tokenFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1234.5 → "1,234.50" */
export function tokens(n: number | null | undefined): string {
  return tokenFmt.format(n ?? 0);
}

/** Chips (minor units) → "12.50" */
export function chips(minor: number | null | undefined): string {
  return tokens((minor ?? 0) / 100);
}

/** Real-money display of a token amount (High-Level Design: winnings are shown in real money). */
export function fiat(tokenAmount: number | null | undefined): string {
  const cfg = appConfig();
  if (!cfg) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cfg.fiatCurrency }).format(
    (tokenAmount ?? 0) * cfg.tokenFiatRate,
  );
}

export function odds(n: number | null | undefined): string {
  return n == null ? '–' : n.toFixed(2);
}

export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function compact(n: number | null | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return new Date(iso).toLocaleDateString();
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/[_.]/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
