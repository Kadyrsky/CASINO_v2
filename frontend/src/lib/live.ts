/** Helpers for the live matches page and the realtime map: assets, ranks, modes, map coordinates. */
import { createQuery } from '@tanstack/solid-query';
import { get } from '../api/client';
import type { GameMode, LiveAssets, MatchMode, ObjectiveKind } from '../api/types';
import { ABILITY_ICONS, ITEM_ICONS, wikiKey } from './wikiIcons';

/** Hero, rank and item names and images, and the map (cached by the core for an hour). */
export function useLiveAssets() {
  return createQuery(() => ({
    queryKey: ['live', 'assets'],
    queryFn: () => get<LiveAssets>('/api/live/assets'),
    staleTime: 60 * 60_000,
    retry: 2,
  }));
}

export const TEAM_NAMES = ['Hidden King', 'Archmother'] as const;
export const TEAM_COLOR = ['var(--color-amber-team)', 'var(--color-sapphire-team)'] as const;
export const TEAM_TEXT = ['text-amber-team', 'text-sapphire-team'] as const;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

export interface RankInfo {
  tier: number;
  subrank: number;
  name: string;
  image: string | null;
  color: string | null;
  /** "Ascendant V" */
  label: string;
}

export function rankOf(assets: LiveAssets | undefined, badge: number | null | undefined): RankInfo | null {
  if (!badge || badge < 10) return null;
  const tier = Math.floor(badge / 10);
  const subrank = badge % 10;
  const r = assets?.ranks[String(tier)];
  const name = r?.name ?? `Tier ${tier}`;
  return { tier, subrank, name, image: r?.image ?? null, color: r?.color ?? null, label: `${name} ${ROMAN[subrank - 1] ?? ''}`.trim() };
}

export function roman(n: number): string {
  return ROMAN[n - 1] ?? String(n);
}

export function heroOf(assets: LiveAssets | undefined, id: number) {
  return assets?.heroes[String(id)] ?? null;
}

/** An item's name and icon: the Deadlock Wiki's icon (the game's current art) when there is one, else deadlock-api's. */
export function itemOf(assets: LiveAssets | undefined, id: number) {
  const item = assets?.items[String(id)];
  if (!item) return null;
  const file = ITEM_ICONS[wikiKey(item.name)];
  return file ? { ...item, image: `/icons/items/${file}.webp` } : item;
}

/** A hero ability's name and icon: the Deadlock Wiki's icon when there is one, else deadlock-api's. */
export function abilityOf(assets: LiveAssets | undefined, id: number) {
  const ability = assets?.abilities?.[String(id)];
  if (!ability) return null;
  const file = ABILITY_ICONS[wikiKey(ability.name)];
  return file ? { ...ability, image: `/icons/abilities/${file}.webp` } : ability;
}

export const URN_ICON = '/icons/objectives/urn.webp';
export const RIFT_ICON = '/icons/objectives/rift.webp';

/**
 * A map objective's icon from the Deadlock Wiki (see scripts/wiki_icons.py). Patrons show their team's glyph; base
 * guardians, a different statue for each team, their team's.
 */
export function objectiveIcon(kind: ObjectiveKind, team: 0 | 1 | null): string | null {
  switch (kind) {
    case 'guardian':
      return '/icons/objectives/guardian.webp';
    case 'base_guardian':
      return `/icons/objectives/base-guardian-${team ?? 0}.webp`;
    case 'walker':
      return '/icons/objectives/walker.webp';
    case 'patron':
    case 'patron_core':
      return team == null ? null : `/icons/objectives/patron-${team}.webp`;
    case 'midboss':
      return '/icons/objectives/midboss.webp';
  }
}

export const MODE_LABEL: Record<MatchMode, string> = {
  ranked: 'Ranked',
  unranked: 'Unranked',
  private: 'Private',
  bots: 'Bots',
  placement: 'Placement',
  other: 'Other',
};

export const GAME_MODE_LABEL: Record<GameMode, string> = { normal: '6v6', street_brawl: 'Street Brawl', other: 'Other' };

const REGIONS: Record<string, string> = {
  europe: 'Europe',
  row: 'Rest of world',
  seasia: 'SE Asia',
  samerica: 'S America',
  russia: 'Russia',
  oceania: 'Oceania',
};

export function regionLabel(region: string | null | undefined): string {
  return region ? (REGIONS[region] ?? region) : '—';
}

/**
 * World position → [0, 1] map position (x right, y down). The minimap image covers [-radius, radius] on both axes
 * (checked against deadlock-api's neutral camp positions), unless the broadcast sends its own bounds.
 */
export function toMap(
  x: number,
  y: number,
  radius: number,
  bounds?: [number, number, number, number] | null,
): [number, number] {
  const [minX, minY, maxX, maxY] = bounds ?? [-radius, -radius, radius, radius];
  return [(x - minX) / (maxX - minX), 1 - (y - minY) / (maxY - minY)];
}
