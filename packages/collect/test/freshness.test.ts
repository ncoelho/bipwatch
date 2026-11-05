import { describe, expect, it } from 'vitest';
import { computeFreshness, formatReport, SOURCES, toExport, type SourceRow } from '../src/freshness.ts';

const now = new Date('2026-11-05T12:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60000);

describe('computeFreshness', () => {
  const rows: SourceRow[] = [
    { source: 'bips-repo', last_success: ago(59), last_failure: null, documents: 91 },
    { source: 'delving', last_success: ago(61), last_failure: ago(5), documents: 4905 },
    { source: 'mailing-list', last_success: ago(120), last_failure: null, documents: 24709 },
  ];
  const report = computeFreshness(rows, now);
  const by = Object.fromEntries(report.sources.map((s) => [s.source, s]));

  it('is fresh up to twice the cadence and stale after', () => {
    expect(by['bips-repo'].stale).toBe(false); // 59 <= 60
    expect(by.delving.stale).toBe(true); // 61 > 60
    expect(by['mailing-list'].stale).toBe(false); // 120 <= 120
  });

  it('treats a source that never succeeded as stale', () => {
    expect(by.github).toMatchObject({ last_success: null, stale: true, documents: 0 });
  });

  it('lists every known source in a fixed order', () => {
    expect(report.sources.map((s) => s.source)).toEqual(SOURCES.map((s) => s.source));
  });

  it('exports no failure detail', () => {
    const exported = toExport(report);
    expect(Object.keys(exported)).toEqual(['generated_at', 'sources']);
    expect(JSON.stringify(exported)).not.toContain('failure');
  });

  it('reports a failure newer than the last success', () => {
    const text = formatReport(report);
    expect(text).toMatch(/STALE\s+delving\s+61 min ago.*last run failed/);
    expect(text).toMatch(/ok\s+bips-repo\s+59 min ago/);
    expect(text).toMatch(/STALE\s+github\s+never/);
  });
});
