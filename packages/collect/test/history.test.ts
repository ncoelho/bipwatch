import { describe, expect, it } from 'vitest';
import { bip3Status, headerEnd, parseSpecLog, statusSince } from '../src/bips/history.ts';

const S = '\u0001';
const entry = (sha: string, date: string, subject: string, body: string, diff: string) =>
  `${S}${sha}\x1f${date}T10:00:00+00:00\x1f${subject}\x1f${body}\n${diff}`;

describe('spec history', () => {
  it('finds where the header ends in markdown and mediawiki specs', () => {
    expect(headerEnd('```\n  BIP: 54\n  Status: Complete\n```\n\n## Abstract')).toBe(4);
    expect(headerEnd('<pre>\n  BIP: 352\n</pre>\n== Abstract ==')).toBe(3);
    expect(headerEnd('no header here')).toBe(0);
  });

  it('reads one change per merged PR: header, body, changelog, status and version', () => {
    const log = [
      entry('aaa', '2024-05-08', 'Merge pull request #1458 from josibake/bip352', 'Add BIP352: Silent Payments\n',
        'diff --git a/x b/x\n@@ -0,0 +1,40 @@\n+<pre>\n+  Status: Draft\n+</pre>\n+== Abstract =='),
      entry('bbb', '2024-06-01', 'BIP352: mark as proposed (#1600)', '',
        'diff --git a/x b/x\n@@ -8 +8 @@\n-  Status: Draft\n+  Status: Proposed'),
      entry('ccc', '2026-03-01', 'Merge pull request #2000 from a/b', 'BIP352: change scanning\n',
        'diff --git a/x b/x\n@@ -100,2 +100,3 @@\n+text\n@@ -300 +301,2 @@\n+* __1.1.0__ (2026-03-01):\n+** Scanning changed.'),
      entry('ddd', '2026-04-01', 'Merge pull request #2100 from a/c', 'BIP352: reword\n', 'diff --git a/x b/x\n@@ -120 +120 @@\n-old\n+new'),
    ].join('');
    const h = parseSpecLog(log, 18);
    expect(h.map((c) => [c.sha, c.pr, c.title])).toEqual([
      ['aaa', 1458, 'Add BIP352: Silent Payments'],
      ['bbb', 1600, 'BIP352: mark as proposed'],
      ['ccc', 2000, 'BIP352: change scanning'],
      ['ddd', 2100, 'BIP352: reword'],
    ]);
    expect(h[1]).toMatchObject({ header: true, body: false, status: 'Proposed' });
    expect(h[2]).toMatchObject({ header: false, body: true, changelog: true, version: '1.1.0' });
    expect(h[3]).toMatchObject({ header: false, body: true, changelog: false });
  });

  it('dates a status from its last real change, not from a BIP 3 rename', () => {
    const c = (date: string, status?: string) => ({ sha: date, date, title: '', header: true, body: false, changelog: false, bodyLines: 0, ...(status ? { status } : {}) });
    expect(statusSince([c('2024-05-08', 'Draft'), c('2024-06-01', 'Proposed'), c('2026-01-14', 'Complete'), c('2026-02-01')])).toBe('2024-06-01');
    expect(statusSince([c('2016-02-12', 'Final'), c('2026-01-14', 'Deployed')])).toBe('2016-02-12');
    expect(bip3Status('Withdrawn')).toBe('closed');
  });
});
