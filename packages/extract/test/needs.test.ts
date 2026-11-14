import { describe, expect, it } from 'vitest';
import type { BipBundle, Claim } from '@bipwatch/data';
import { checkNeeds, needsDigest, NEEDS_SYSTEM, toAssessment, type NeedsOutput } from '../src/needs.ts';
import { BIP352 } from './helpers.ts';

const claim = (id: string, over: Partial<Claim>): Claim => ({
  id,
  bip: 352,
  kind: 'task',
  statement: 'Do something.',
  source: { url: 'https://x.test', type: 'forum', retrieved: '2026-11-14' },
  provenance: { extracted_by: 'model:m', extracted: '2026-11-14', reviewed_by: null },
  ...over,
} as Claim);

const bundle: BipBundle = {
  bip: BIP352,
  needs: null,
  claims: [
    claim('task-a', { status: 'open', area: 'design', part_of: 'light-client index', statement: 'Agree how tweak data is served.' }),
    claim('task-b', { status: 'addressed', area: 'testing', statement: 'Add test vectors.' }),
    claim('impl-x', { kind: 'implementation', subject: { name: 'Wallet X', type: 'wallet' }, implementation: { state: 'shipped', send: true, receive: true } }),
    claim('stance-n', { kind: 'stance', stance: 'nack', scope: 'proposal', subject: { name: 'Bob', type: 'person' }, statement: 'Bob opposes it.' }),
  ],
};

const dim = (over = {}) => ({ score: 3, rationale: 'Somewhere in the middle.', evidence: ['task-a'], ...over });
const out = (over: Partial<NeedsOutput> = {}): NeedsOutput => ({
  problem_evidence: dim({ score: null, evidence: [] }),
  technical_maturity: dim(),
  ux_exploration: dim(),
  implementations: dim({ evidence: ['impl-x'] }),
  ecosystem_awareness: dim({ score: null, evidence: [] }),
  coordination: dim(),
  ...over,
});

describe('needs', () => {
  it('digests claims one per line with ids, open work split from addressed', () => {
    const d = needsDigest(bundle);
    expect(d).toContain('## Open work, still open (1)\n[task-a] open task · design · light-client index: Agree how tweak data is served.');
    expect(d).toContain('[task-b] addressed task · testing · BIP 352 itself: Add test vectors.');
    expect(d).toContain('[impl-x] Wallet X: shipped (send+receive)');
    expect(d).toContain('[stance-n] Bob nack: Bob opposes it.');
    expect(d).toContain('Proposal positions in total: 1 nack.');
  });

  it('tells the model which types of work bear on each dimension', () => {
    expect(NEEDS_SYSTEM).toContain('- implementations: Implementations: who has built it');
    expect(NEEDS_SYSTEM).toContain('Open work of type: engineering.');
    expect(NEEDS_SYSTEM).toContain('do not mention the digest');
  });

  it('rejects unknown ids, scores without evidence and long rationales', () => {
    expect(checkNeeds(out(), new Set(['task-a', 'impl-x']))).toEqual([]);
    expect(checkNeeds(out({ coordination: dim({ evidence: ['nope'] }) }), new Set(['task-a', 'impl-x']))).toEqual([
      'coordination: unknown claim id "nope"; copy ids exactly from the digest',
    ]);
    expect(checkNeeds(out({ ux_exploration: dim({ evidence: [] }) }), new Set(['task-a', 'impl-x']))).toEqual([
      'ux_exploration: a score needs evidence, or use null',
    ]);
    expect(checkNeeds(out({ coordination: dim({ rationale: 'x'.repeat(401) }) }), new Set(['task-a', 'impl-x']))[0]).toMatch(/rationale/);
  });

  it('writes a pending assessment, at most 8 distinct evidence ids', () => {
    const a = toAssessment(out({ coordination: dim({ evidence: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }) }), 352, '2026-11-14', 'claude-opus-5-5');
    expect(a.provenance).toEqual({ extracted_by: 'model:claude-opus-5-5', extracted: '2026-11-14', reviewed_by: null });
    expect(a.dimensions.coordination.evidence).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});
