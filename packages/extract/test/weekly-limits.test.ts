import { describe, expect, it } from 'vitest';
import { LEAD_MAX, clip, fits } from '../src/weekly-limits.ts';

describe('clip', () => {
  it('leaves short text alone, tidying spaces', () => {
    expect(clip('  Two  sentences. Fine. ', 400)).toBe('Two sentences. Fine.');
  });
  it('keeps whole sentences when one fits', () => {
    const t = `${'a'.repeat(250)}. ${'b'.repeat(200)}.`;
    expect(clip(t, LEAD_MAX)).toBe(`${'a'.repeat(250)}.`);
  });
  it('falls back to whole words and an ellipsis', () => {
    const t = Array(120).fill('word,').join(' ');
    const out = clip(t, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/word…$/);
  });
});

describe('fits', () => {
  it('checks both limits', () => {
    expect(fits({ headline: 'h', lead: 'x'.repeat(400) })).toBe(true);
    expect(fits({ headline: 'h', lead: 'x'.repeat(401) })).toBe(false);
    expect(fits({ headline: 'h'.repeat(161), lead: 'x' })).toBe(false);
  });
});
