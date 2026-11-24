import { describe, expect, it } from 'vitest';
import type { Claim } from '@bipwatch/data';
import { checkRecheck, closeClaim, olderSpec, recheckable, recheckMessage, resolved, specBatches, type Batch } from '../src/recheck.ts';
import { BIP352 } from './helpers.ts';

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id,
  bip: 352,
  kind: 'task',
  status: 'open',
  area: 'testing',
  statement: 'Fix the test vectors.',
  applies_to_version: '1.0.0',
  source: { url: `https://x.test/${id}`, type: 'forum', date: '2026-05-01', retrieved: '2026-05-02', quote: 'the vectors are wrong' },
  provenance: { extracted_by: 'model:m', extracted: '2026-05-02', reviewed_by: null },
  ...over,
} as Claim);

const batch: Batch = {
  bip: 352,
  thread: 'forum\u0000t1',
  items: [claim('a'), claim('b', { kind: 'open-question', statement: 'Is K_max per scan key?' })],
  messages: [
    { url: 'https://x.test/m1', author: 'Ann', date: '2026-04-01', text: 'An older message that says the vectors were fixed already.' },
    { url: 'https://x.test/m2', author: 'Bob', date: '2026-06-01', text: 'I have pushed the fix: the test vectors now use valid signatures.\nMerged.' },
  ],
};
const spec = 'Senders must count K_max per scan key, not per address.';

describe('recheck', () => {
  it('only rechecks open work without a resolution', () => {
    expect(recheckable(claim('x'))).toBe(true);
    expect(recheckable(claim('x', { status: 'addressed' }))).toBe(false);
    expect(recheckable(claim('x', { kind: 'stance' }))).toBe(false);
  });

  it('numbers the later messages and shows how each item was raised', () => {
    const m = recheckMessage(batch);
    expect(m).toContain('[a] task, raised 2026-05-01 against spec v1.0.0:');
    expect(m).toContain('Raised as: "the vectors are wrong"');
    expect(m).toContain('<message n="2" author="Bob" date="2026-06-01">');
  });

  it('accepts a verbatim quote, ignoring case, spacing and curly quotes', () => {
    const out = {
      items: [
        { id: 'a', status: 'addressed' as const, evidence: 2, quote: 'I have pushed the fix:  the TEST vectors now use valid signatures.' },
        { id: 'b', status: 'addressed' as const, evidence: 'spec' as const, quote: 'Senders must count K_max per scan key' },
      ],
    };
    expect(checkRecheck(out, batch, spec)).toEqual([]);
  });

  it('rejects made-up quotes, missing evidence, earlier messages, unknown and missing ids', () => {
    const errors = checkRecheck(
      {
        items: [
          { id: 'a', status: 'addressed', evidence: 1, quote: 'says the vectors were fixed already' },
          { id: 'b', status: 'addressed', evidence: 2, quote: 'K_max is now counted per scan key, done.' },
          { id: 'zzz', status: 'open', evidence: null, quote: null },
        ],
      },
      batch,
      spec,
    ).join('\n');
    expect(errors).toMatch(/a: message 1 was posted before the item was raised/);
    expect(errors).toMatch(/b: the quote is not in message 2/);
    expect(errors).toMatch(/unknown id "zzz"/);
    expect(checkRecheck({ items: [{ id: 'a', status: 'addressed', evidence: null, quote: null }] }, batch, spec).join('\n')).toMatch(/needs evidence/);
    expect(checkRecheck({ items: [{ id: 'a', status: 'open', evidence: null, quote: null }] }, batch, spec).join('\n')).toMatch(/no answer for "b"/);
  });

  it('closes only the items whose own evidence passes, with the message or spec as the source', () => {
    const out = {
      items: [
        { id: 'a', status: 'addressed' as const, evidence: 2, quote: 'the test vectors now use valid signatures.' },
        { id: 'b', status: 'addressed' as const, evidence: 'spec' as const, quote: 'not in the spec at all, invented' },
      ],
    };
    const r = resolved(out, batch, BIP352, spec, 'claude-opus-5-5', '2026-11-24');
    expect(r.map((x) => x.claim.id)).toEqual(['a']);
    expect(r[0].resolution).toEqual({ url: 'https://x.test/m2', quote: 'the test vectors now use valid signatures.', date: '2026-06-01', found_by: 'model:claude-opus-5-5', found: '2026-11-24' });
    const closed = closeClaim(r[0]);
    expect(closed.status).toBe('addressed');
    expect(closed.provenance.reviewed_by).toBeNull();
    const s = resolved({ items: [{ id: 'b', status: 'addressed', evidence: 'spec', quote: 'Senders must count K_max per scan key' }] }, batch, BIP352, spec, 'm', '2026-11-24');
    expect(s[0].resolution.url).toBe(`https://github.com/bitcoin/bips/blob/${BIP352.spec.revision}/${BIP352.spec.path}`);
  });

  it('batches items raised on an older spec version, BIP text only', () => {
    expect(olderSpec('1.0.0', '1.1.0')).toBe(true);
    expect(olderSpec('1.1.0', '1.1.3')).toBe(false);
    const items = [...Array(14)].map((_, i) => claim(`s${i}`)).concat(claim('piece', { part_of: 'light-client index' }), claim('new', { applies_to_version: '1.1.0' }));
    const b = specBatches(BIP352, items, (v) => olderSpec(v, '1.1.0'));
    expect(b.map((x) => x.items.length)).toEqual([12, 2]);
    expect(b[0]).toMatchObject({ thread: 'spec', messages: [] });
  });
});
