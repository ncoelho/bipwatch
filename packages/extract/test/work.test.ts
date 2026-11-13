import { describe, expect, it } from 'vitest';
import { normalisePartOf, WorkOutput, workTask } from '../src/tasks/work/index.ts';
import { makeValidator } from '../src/validate.ts';
import { bips, doc } from './helpers.ts';

const ctx = { bips, today: '2026-11-13', modelId: 'claude-opus-5-5' };
const BODY = 'Looks promising. This still needs test vectors for the label edge cases.\nHow would light clients scan for these?';
const LATER = 'josibake (2026-03-01): Good point, I added label test vectors in the latest push.';
const item = (over = {}) => ({
  bip: 352,
  kind: 'task' as const,
  area: 'testing' as const,
  status: 'addressed' as const,
  part_of: null as string | null,
  statement: 'Add test vectors covering label edge cases.',
  quote: 'This still needs test vectors for the label edge cases.',
  ...over,
});
const d = doc(1, BODY, { later: LATER, posted_at: new Date('2026-02-20') });

describe('work task', () => {
  it('puts the document and the later replies in the prompt, clearly apart', () => {
    const msg = workTask.userMessage(d, [...bips.values()]);
    expect(msg).toContain('- BIP 352: Silent Payments (status: Complete)');
    expect(msg).toContain(`<document>\n${BODY}\n</document>`);
    expect(msg).toContain('<later_replies>');
    expect(msg).toContain('never quote them');
    expect(msg).toContain(LATER);
    expect(workTask.userMessage(doc(2, BODY), [...bips.values()])).toContain('<later_replies>None archived.</later_replies>');
  });

  it('turns items into schema-valid tasks, questions and objections raised by the author', () => {
    const claims = workTask.toClaims(
      { items: [item(), item({ kind: 'open-question', area: 'research', status: 'open', statement: 'Work out how light clients can scan for silent payments.', quote: 'How would light clients scan for these?' })] },
      d,
      ctx,
    );
    expect(claims.map((c) => [c.kind, c.area, c.status])).toEqual([
      ['task', 'testing', 'addressed'],
      ['open-question', 'research', 'open'],
    ]);
    expect(claims[0]).toMatchObject({
      subject: { name: 'Alice Example', type: 'person' },
      applies_to_version: '1.1.2',
      provenance: { extracted_by: 'model:claude-opus-5-5', reviewed_by: null },
    });
    expect(claims[0].id).toMatch(/^task-alice-example-[0-9a-f]{8}$/);
    const v = makeValidator([]);
    for (const c of claims) expect(v.validate(c, d)).toEqual([]);
  });

  it('names companion work in part_of, normalised, and never the BIP itself', () => {
    const claims = workTask.toClaims(
      { items: [item({ part_of: 'bip-0375' }), item({ part_of: ' Light client  index ' }), item({ part_of: 'BIP 352' }), item(), item({ part_of: 'light-client-index' })] },
      d,
      ctx,
    );
    // The second spelling of the same name reuses the first one seen.
    expect(claims.map((c) => c.part_of)).toEqual(['BIP 375', 'light-client index', undefined, undefined, 'light-client index']);
    // Later documents are told which names are in use.
    expect(workTask.userMessage(d, [...bips.values()])).toContain('part_of names already used for BIP 352 (reuse one when it fits): BIP 375; light-client index');
    const v = makeValidator([]);
    expect(v.validate(claims[0], d)).toEqual([]);
  });

  it('rejects a quote taken from the later replies', () => {
    const [c] = workTask.toClaims({ items: [item({ quote: 'I added label test vectors in the latest push.' })] }, d, ctx);
    expect(makeValidator([]).validate(c, d)).toEqual([
      'quote: not found verbatim in the document; copy an exact span of its text',
    ]);
  });

  it('only allows the known kinds, areas and statuses', () => {
    expect(WorkOutput.safeParse({ items: [item({ kind: 'stance' })] }).success).toBe(false);
    expect(WorkOutput.safeParse({ items: [item({ area: 'marketing' })] }).success).toBe(false);
    expect(WorkOutput.safeParse({ items: [item({ status: 'unknown' })] }).success).toBe(false);
    expect(WorkOutput.safeParse({ items: [item()] }).success).toBe(true);
  });
});

describe('normalisePartOf', () => {
  it('reuses known spellings and drops the BIP itself', () => {
    expect(normalisePartOf('Light-Client Index', 352, ['light-client index'])).toBe('light-client index');
    expect(normalisePartOf('BIP-0352', 352, [])).toBeNull();
    expect(normalisePartOf('bip375', 352, [])).toBe('BIP 375');
    expect(normalisePartOf('Light client protocol', 352, [])).toBe('light-client protocol');
    expect(normalisePartOf('  ', 352, [])).toBeNull();
  });
});

describe('work task context', () => {
  it('gives the model the current spec and names the companions', () => {
    const [ctxBip] = [...bips.values()];
    const text = workTask.context!([{ ...ctxBip, bip: { ...ctxBip.bip, related: [375, 376], requires: [340] }, specText: '== Abstract ==\nSilent payments.', companions: [{ number: 375, text: 'PSBT fields.' }] }]);
    expect(text).toContain('Current text of BIP 352 (Silent Payments)');
    expect(text).toContain('(name one in part_of when work belongs to it): BIP 375, BIP 376, BIP 340.');
    expect(text).toContain('<spec bip="352">\n== Abstract ==\nSilent payments.\n</spec>');
    expect(text).toContain('Current text of companion BIP 375, for judging the status of work that belongs to it:\n<spec bip="375">\nPSBT fields.\n</spec>');
    expect(workTask.version).toBe(3);
    expect(workTask.skipSources).toEqual(['bips-repo']);
    expect(workTask.system).toContain('A design question the current spec settles');
  });
});
