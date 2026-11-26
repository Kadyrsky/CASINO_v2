import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import type { LiveAssets, ObjectiveKind } from '../api/types';
import { itemOf, objectiveIcon } from './live';

/** The site's assets as the live service serves them (deadlock-api's, kept compact), from e2e/fixtures. */
const assets = JSON.parse(readFileSync(new URL('../../e2e/fixtures/assets.json', import.meta.url), 'utf8')) as LiveAssets;

describe('items as the live page shows them', () => {
  it("shows every item the shop sells with the Deadlock Wiki's icon and its game name", () => {
    const shop = Object.entries(assets.items).filter(([, item]) => item.shop);
    expect(shop.length).toBeGreaterThan(150);
    for (const [id, raw] of shop) {
      const item = itemOf(assets, Number(id))!;
      expect(item.name, id).toBe(raw.name);
      expect(item.name, id).not.toMatch(/^upgrade_|Disabled|\bv\d+$/);
      expect(item.image, item.name).toMatch(/^\/icons\/items\/[a-z0-9-]+\.webp$/);
      expect(existsSync(new URL(`../../public${item.image}`, import.meta.url)), item.image!).toBe(true);
    }
  });

  it("keeps deadlock-api's art for an item the wiki has no icon for, such as a removed one", () => {
    const [id, removed] = Object.entries(assets.items).find(([, item]) => item.name === 'upgrade_weapon_instant_reload')!;
    expect(removed.shop).toBe(false);
    expect(itemOf(assets, Number(id))!.image).toBe(removed.image);
  });
});

describe('objectives as the live page shows them', () => {
  it('gives every kind of objective of either team an icon the site ships, the shrines theirs', () => {
    const kinds: ObjectiveKind[] = ['guardian', 'walker', 'base_guardian', 'shrine', 'patron', 'patron_core', 'midboss'];
    for (const kind of kinds) {
      for (const team of [0, 1] as const) {
        const icon = objectiveIcon(kind, team)!;
        expect(icon, kind).toMatch(/^\/icons\/objectives\/[a-z0-9-]+\.webp$/);
        expect(existsSync(new URL(`../../public${icon}`, import.meta.url)), icon).toBe(true);
      }
    }
    expect(objectiveIcon('shrine', 1)).toBe('/icons/objectives/shrine.webp');
  });
});
