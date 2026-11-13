import { describe, expect, it } from 'vitest';
import { prSummary } from '../src/summary.ts';
import { stanceTask } from '../src/tasks/stance/index.ts';
import { bips, doc } from './helpers.ts';

const ctx = { bips, today: '2026-11-13', modelId: 'claude-opus-5-5' };
const pr = doc(2, 'ACK abc123 | tested', {
  source: 'github',
  thread_key: 'bitcoin/bips#2348',
  thread_title: 'bip-0352: fix input encodings',
  author: 'Eunovo',
  url: 'https://github.com/bitcoin/bips/pull/2348#review-1',
  posted_at: new Date('2026-11-06T10:00:00Z'),
});
const [change] = stanceTask.toClaims(
  { stances: [{ bip: 352, stance: 'ack', scope: 'change', condition: null, statement: 'Eunovo approved | the fix.', quote: 'ACK abc123 | tested' }] },
  pr,
  ctx,
);
const [proposal] = stanceTask.toClaims(
  { stances: [{ bip: 352, stance: 'nack', scope: 'proposal', condition: null, statement: 'Alice opposes it.', quote: 'NACK' }] },
  doc(1, 'NACK'),
  ctx,
);

describe('prSummary', () => {
  const body = prSummary({
    claims: [change, proposal],
    runs: [{ bip: 352, runId: 27, docs: 19, inputTokens: 38291, outputTokens: 696 }],
    task: { id: stanceTask.id, version: stanceTask.version, model: stanceTask.model },
  });

  it('says what it is, how many, and that nothing is reviewed', () => {
    expect(body).toContain('2 claims proposed by the `stance` extractor (v2, `model:claude-opus-5-5`) from 19 newly archived documents');
    expect(body).toContain('All have `reviewed_by: null`');
    expect(body).toContain('1 is a position on the proposal itself');
  });

  it('lists positions on the proposal first, each with its source link and file', () => {
    const rows = body.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('`nack` (proposal) | Alice Example');
    expect(rows[1]).toContain('`ack` (change) | Eunovo');
    expect(rows[1]).toContain('(https://github.com/bitcoin/bips/pull/2348#review-1) · [PR](https://github.com/bitcoin/bips/pull/2348)');
    expect(rows[1]).toContain(`\`data/bips/0352/claims/${change.id}.yaml\``);
  });

  it('escapes table pipes in statements and quotes', () => {
    expect(body).toContain('Eunovo approved \\| the fix.');
    expect(body).toContain('“ACK abc123 \\| tested”');
  });

  it('reports the run and its tokens', () => {
    expect(body).toContain('Extraction run 27 (BIP 352): 38,291 input + 696 output tokens');
  });
});
