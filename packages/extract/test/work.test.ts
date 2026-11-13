import { describe, expect, it } from 'vitest';
import { WorkOutput, workTask } from '../src/tasks/work/index.ts';
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

describe('work task context', () => {
  it('gives the model the current spec and names the companions', () => {
    const [ctxBip] = [...bips.values()];
    const text = workTask.context!([{ ...ctxBip, bip: { ...ctxBip.bip, related: [375, 376], requires: [340] }, specText: '== Abstract ==\nSilent payments.' }]);
    expect(text).toContain('Current text of BIP 352 (Silent Payments)');
    expect(text).toContain('whose own work is not recorded here: BIP 375, BIP 376, BIP 340.');
    expect(text).toContain('<spec bip="352">\n== Abstract ==\nSilent payments.\n</spec>');
    expect(workTask.version).toBe(2);
    expect(workTask.system).toContain('A design question the current spec settles');
  });
});
