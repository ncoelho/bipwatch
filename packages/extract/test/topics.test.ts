import { describe, expect, it } from 'vitest';
import type { BipBundle, Claim } from '@bipwatch/data';
import { checkTopics, toTopics, topicsDigest, validTopics } from '../src/topics.ts';
import { BIP352 } from './helpers.ts';

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id,
  bip: 352,
  kind: 'task',
  status: 'open',
  area: 'testing',
  statement: 'Fix the test vectors.',
  source: { url: 'https://x.test', type: 'forum', retrieved: '2026-11-24' },
  provenance: { extracted_by: 'model:m', extracted: '2026-11-24', reviewed_by: null },
  ...over,
} as Claim);

const bundle: BipBundle = {
  bip: BIP352,
  needs: null,
  claims: [
    claim('a'),
    claim('b', { statement: 'Correct the consensus-invalid test vectors.' }),
    claim('c', { part_of: 'light-client index' }),
    claim('d', { part_of: 'light-client index' }),
    claim('lone', { part_of: 'wallet support' }),
    claim('done', { status: 'addressed' }),
    claim('impl', { kind: 'implementation' }),
  ],
};

describe('topics', () => {
  it('digests open work by piece, leaving out pieces with one item and addressed items', () => {
    const d = topicsDigest(bundle);
    expect(d).toContain('## BIP 352 itself (2)');
    expect(d).toContain('[b] task · testing: Correct the consensus-invalid test vectors.');
    expect(d).toContain('## light-client index (2)');
    expect(d).not.toContain('wallet support');
    expect(d).not.toContain('[done]');
    expect(d).not.toContain('[impl]');
  });

  it('accepts groups of known open items on one piece', () => {
    expect(checkTopics({ topics: [{ title: 'Fix the test vectors', items: ['a', 'b'] }] }, bundle)).toEqual([]);
  });

  it('rejects unknown, addressed, repeated, lone and cross-piece items', () => {
    const errors = checkTopics(
      {
        topics: [
          { title: 'Fix the test vectors', items: ['a', 'c'] },
          { title: 'Something done', items: ['done', 'zzz'] },
          { title: 'Repeat', items: ['a'] },
        ],
      },
      bundle,
    );
    expect(errors.join('\n')).toMatch(/mixes pieces/);
    expect(errors.join('\n')).toMatch(/unknown id "done"/);
    expect(errors.join('\n')).toMatch(/unknown id "zzz"/);
    expect(errors.join('\n')).toMatch(/already in another topic/);
    expect(errors.join('\n')).toMatch(/two or more items/);
    expect(errors.join('\n')).toMatch(/10 to 160 characters/);
  });

  it('keeps the groups that pass on their own', () => {
    const kept = validTopics({ topics: [{ title: 'Fix the test vectors', items: ['a', 'b'] }, { title: 'Mixed pieces here', items: ['b', 'c'] }, { title: 'Light client index work', items: ['c', 'd', 'd'] }] }, bundle);
    expect(kept.topics.map((t) => t.items)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('writes slug ids, unique, with machine provenance', () => {
    const t = toTopics({ topics: [{ title: 'Fix the test vectors!', items: ['a', 'b'] }, { title: 'Fix the test vectors', items: ['c', 'd'] }] }, 352, '2026-11-24', 'claude-opus-5-5');
    expect(t.topics.map((x) => x.id)).toEqual(['fix-the-test-vectors', 'fix-the-test-vectors-2']);
    expect(t.provenance).toEqual({ extracted_by: 'model:claude-opus-5-5', extracted: '2026-11-24', reviewed_by: null });
  });
});
