import { describe, expect, it } from 'vitest';
import { loadAll } from '@bipwatch/data';
import { StanceOutput, stanceTask } from '../src/tasks/stance/index.ts';
import { makeValidator, normalize } from '../src/validate.ts';
import { bips, doc } from './helpers.ts';

const ctx = { bips, today: '2026-11-06', modelId: 'claude-opus-5-5' };
const BODY = 'I think this is a great direction.\n\nConcept ACK on silent\npayments, though scanning cost worries me.';
const stance = (over = {}) => ({
  bip: 352,
  stance: 'concept-ack' as const,
  scope: 'proposal' as const,
  condition: null,
  statement: 'Alice Example supports the idea of silent payments but is worried about scanning cost.',
  quote: 'Concept ACK on silent payments',
  ...over,
});

describe('stance task', () => {
  it('builds the prompt from the document and the spec version at the time', () => {
    const msg = stanceTask.userMessage(doc(1, BODY), [...bips.values()]);
    expect(msg).toContain('- BIP 352: Silent Payments (spec version at the time: none yet)');
    expect(msg).toContain('Author: Alice Example');
    expect(msg).toContain('Source: bitcoin-dev mailing list message');
    expect(msg).toContain(`<document>\n${BODY}\n</document>`);
    const later = stanceTask.userMessage(doc(2, BODY, { posted_at: new Date('2026-01-01') }), [...bips.values()]);
    expect(later).toContain('(spec version at the time: 1.1.2)');
  });

  it('turns output into a schema-valid stance claim attributed by code', () => {
    const [claim] = stanceTask.toClaims({ stances: [stance()] }, doc(1, BODY), ctx);
    expect(claim).toMatchObject({
      bip: 352,
      kind: 'stance',
      stance: 'concept-ack',
      subject: { name: 'Alice Example', type: 'person' },
      applies_to_version: '0.0.0',
      source: { type: 'mailing-list', date: '2022-03-29', retrieved: '2026-11-06', verified: true },
      provenance: { extracted_by: 'model:claude-opus-5-5', extracted: '2026-11-06', reviewed_by: null },
    });
    expect(claim.id).toMatch(/^stance-alice-example-[0-9a-f]{8}$/);
    expect(claim).not.toHaveProperty('condition');
    const v = makeValidator([]);
    expect(v.validate(claim, doc(1, BODY))).toEqual([]);
  });

  it('keeps the condition only on conditional stances', () => {
    const [c] = stanceTask.toClaims(
      { stances: [stance({ stance: 'conditional', condition: 'if scanning gets cheaper' })] },
      doc(1, BODY),
      ctx,
    );
    expect(c.condition).toBe('if scanning gets cheaper');
  });
});

describe('stance v2 scope', () => {
  const prDoc = doc(3, 'ACK 3795b71', {
    source: 'github',
    thread_key: 'bitcoin/bips#2055',
    thread_title: 'BIP352: limit the number of recipients',
    author: 'RubenSomsen',
    url: 'https://github.com/bitcoin/bips/pull/2055#issuecomment-1',
  });

  it('links a change-scoped stance to its pull request', () => {
    const [c] = stanceTask.toClaims({ stances: [stance({ stance: 'ack', scope: 'change', quote: 'ACK 3795b71' })] }, prDoc, ctx);
    expect(c.scope).toBe('change');
    expect(c.change).toEqual({ url: 'https://github.com/bitcoin/bips/pull/2055', title: 'BIP352: limit the number of recipients' });
    expect(makeValidator([]).validate(c, prDoc)).toEqual([]);
  });

  it('gives proposal-scoped stances no change link', () => {
    const [c] = stanceTask.toClaims({ stances: [stance({ quote: 'ACK 3795b71' })] }, prDoc, ctx);
    expect(c).not.toHaveProperty('change');
  });

  it('maps logins to the person in people.yaml', () => {
    const [c] = stanceTask.toClaims({ stances: [stance({ scope: 'change', quote: 'ACK 3795b71' })] }, prDoc, ctx);
    expect(c.subject).toEqual({ name: 'Ruben Somsen', type: 'person' });
    expect(c.id).toMatch(/^stance-ruben-somsen-/);
  });

  it('asks the model for a scope', () => {
    expect(stanceTask.version).toBe(3);
    expect(stanceTask.continuesFrom).toEqual([2]);
    expect(stanceTask.system).toContain('is review of that change, not a position on the proposal');
    expect(StanceOutput.safeParse({ stances: [{ ...stance(), scope: 'everything' }] }).success).toBe(false);
  });
});

describe('validator', () => {
  const v = () => makeValidator([]);
  const claimFor = (over = {}) => stanceTask.toClaims({ stances: [stance(over)] }, doc(1, BODY), ctx)[0];

  it('accepts a quote that differs only in whitespace (a wrapped line)', () => {
    expect(normalize('silent\npayments')).toBe('silent payments');
    expect(v().validate(claimFor(), doc(1, BODY))).toEqual([]);
  });

  it('rejects a quote that is not in the document', () => {
    const errors = v().validate(claimFor({ quote: 'Concept ACK on Silent Payments!' }), doc(1, BODY));
    expect(errors).toEqual(['quote: not found verbatim in the document; copy an exact span of its text']);
  });

  it('rejects a BIP the document does not mention', () => {
    const errors = v().validate(claimFor({ bip: 341 }), doc(1, BODY));
    expect(errors.some((e) => e.startsWith('bip: 341'))).toBe(true);
  });

  it('rejects schema violations, e.g. a conditional stance without a condition', () => {
    const errors = v().validate(claimFor({ stance: 'conditional', condition: null }), doc(1, BODY));
    expect(errors.some((e) => e.startsWith('schema:') && e.includes('condition'))).toBe(true);
  });

  it('rejects a duplicate of an existing or already accepted claim', () => {
    const val = v();
    const c = claimFor();
    expect(val.validate(c, doc(1, BODY))).toEqual([]);
    val.remember(c);
    expect(val.validate({ ...c, id: 'stance-other' }, doc(1, BODY))).toContain(
      'duplicate: a claim with the same kind, subject and quote exists',
    );
  });

  it('treats the same short quote on another source as a new claim', () => {
    const val = v();
    const c = claimFor({ quote: 'Concept ACK' });
    val.remember(c);
    const other = { ...c, id: 'stance-other', source: { ...c.source, url: 'https://github.com/bitcoin/bips/pull/1#x' } };
    expect(val.validate(other, doc(1, BODY))).toEqual([]);
  });

  it('knows every claim already in data/', () => {
    const existing = loadAll().flatMap((b) => b.claims);
    const val = makeValidator(existing);
    const copy = { ...existing[0], id: 'copy' };
    expect(val.validate(copy, doc(1, copy.source.quote ?? '', { bips: [copy.bip] }))).toContain(
      'duplicate: a claim with the same kind, subject and quote exists',
    );
  });
});
