import { describe, expect, it } from 'vite-plus/test';
import { versionLabel } from './version';

describe('versionLabel', () => {
  it('shows a release as vMAJOR.MINOR.PATCH', () => {
    expect(versionLabel('1.5.0')).toBe('v1.5.0');
    expect(versionLabel('10.0.12')).toBe('v10.0.12');
  });

  it("takes the number with or without its tag's v, and ignores spaces around it", () => {
    expect(versionLabel('v1.5.0')).toBe('v1.5.0');
    expect(versionLabel(' 1.5.0\n')).toBe('v1.5.0');
  });

  it('keeps what git describe adds to a build between releases', () => {
    expect(versionLabel('v1.5.0-3-gabc1234')).toBe('v1.5.0-3-gabc1234');
  });

  it('says dev when the build was given no version', () => {
    expect(versionLabel(undefined)).toBe('dev');
    expect(versionLabel('')).toBe('dev');
    expect(versionLabel('dev')).toBe('dev');
  });
});
