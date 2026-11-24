import { describe, expect, it } from 'vite-plus/test';
import type { PowerupKind } from '../api/types';
import { powerupLabel } from '../components/liveMapLayers';
import { POWERUP_LOOKS } from './powerupIcons';

describe('POWERUP_LOOKS', () => {
  it('has a name, a colour and an icon for every kind the bot reports', () => {
    const kinds: PowerupKind[] = ['gun', 'survival', 'casting', 'movement'];
    expect(Object.keys(POWERUP_LOOKS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const look = POWERUP_LOOKS[kind];
      expect(look.name).toMatch(/^[A-Z]/);
      expect(look.gives.length).toBeGreaterThan(0);
      expect(look.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(look.box.every((v) => v > 0)).toBe(true);
      expect(look.paths.length).toBeGreaterThan(0);
      for (const p of look.paths) {
        expect(p.d).toMatch(/^M/);
        expect(p.opacity).toBeGreaterThan(0);
        expect(p.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('names a power-up by its kind, or plainly when the kind is not known', () => {
    expect(powerupLabel('gun')).toBe(`Gun power-up · ${POWERUP_LOOKS.gun.gives}`);
    expect(powerupLabel(null)).toBe('Bridge power-up');
    expect(powerupLabel(undefined)).toBe('Bridge power-up');
  });
});
