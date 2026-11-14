import { describe, expect, it } from 'vitest';
import { dataChecks, type BipBundle, type Claim } from '../src/index.ts';

const impl = (id: string, state: string, url: string): Claim => ({
  id, bip: 352, kind: 'implementation', statement: 'x',
  subject: { name: id, type: 'node', url },
  implementation: { state } as Claim['implementation'],
  source: { url, type: 'github', retrieved: '2026-11-14' },
  provenance: { extracted_by: 'model:m', extracted: '2026-11-01', reviewed_by: null },
});
const bundle = (claims: Claim[], needsAssessed?: string): BipBundle => ({
  bip: { number: 352, spec: { revision: 'aaa', synced: '2026-11-01' } } as BipBundle['bip'],
  claims,
  needs: needsAssessed ? ({ assessed: needsAssessed } as BipBundle['needs']) : null,
});
const U = (n: number) => `https://github.com/bitcoin/bitcoin/pull/${n}`;
const prs = { generated_at: '', prs: {
  [U(1)]: { state: 'merged' as const, opened: '2026-01-01', merged: '2026-09-23' },
  [U(2)]: { state: 'closed' as const, opened: '2026-01-01', merged: null },
  [U(3)]: { state: 'open' as const, opened: '2026-01-01', merged: null },
} };

describe('dataChecks', () => {
  it('flags implementation states that contradict their pull request', () => {
    const out = dataChecks(bundle([impl('a', 'in-review', U(1)), impl('b', 'in-review', U(2)), impl('c', 'merged', U(3)), impl('d', 'in-review', U(3))]), null, prs);
    expect(out.map((c) => [c.subject, c.file])).toEqual([
      ['a', 'data/bips/0352/claims/a.yaml'],
      ['b', 'data/bips/0352/claims/b.yaml'],
      ['c', 'data/bips/0352/claims/c.yaml'],
    ]);
    expect(out[0].text).toContain('merged on 2026-09-23');
  });

  it('flags a spec revision behind the history and an outdated needs assessment', () => {
    const history = { bip: 352, path: 'x', versions: [], changes: [{ sha: 'bbb', date: '2026-11-05', title: 'Add vector', header: false, body: true, changelog: false, bodyLines: 3, type: 'edit' as const, by: 'labels' as const, flag: false }] };
    const many = Array.from({ length: 10 }, (_, i) => ({ ...impl(`x${i}`, 'shipped', U(9)), provenance: { extracted_by: 'm', extracted: '2026-11-10', reviewed_by: null } }));
    const out = dataChecks(bundle(many, '2026-11-05'), history, null);
    expect(out.map((c) => c.subject)).toEqual(['Spec revision', 'What it needs']);
    expect(dataChecks(bundle([], '2026-11-05'), { ...history, changes: [{ ...history.changes[0], sha: 'aaa' }] }, null)).toEqual([]);
  });
});
