import { describe, expect, it } from 'vite-plus/test';
import { needsDisclaimer } from './disclaimerRule';

describe('needsDisclaimer', () => {
  it('shows the notice to a visitor who is not logged in', () => {
    expect(needsDisclaimer(false, false)).toBe(true);
  });

  it('does not show it again during the same visit once accepted', () => {
    expect(needsDisclaimer(false, true)).toBe(false);
  });

  it('never shows it to a logged-in player', () => {
    expect(needsDisclaimer(true, false)).toBe(false);
    expect(needsDisclaimer(true, true)).toBe(false);
  });
});
