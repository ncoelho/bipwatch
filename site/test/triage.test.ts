import { describe, expect, it } from 'vitest';
import { NEED_DIMENSIONS, type BipBundle, type Claim, type NeedsAssessment } from '@bipwatch/data';
import { triager, weakDimensions, withTopicChoices, type Triage } from '../src/lib/triage.ts';

const today = new Date('2026-11-24T12:00:00Z');
let n = 0;
const claim = (over: Partial<Claim>): Claim => ({
  id: `c${++n}`,
  bip: 352,
  kind: 'task',
  status: 'open',
  area: 'engineering',
  statement: 'Do a thing.',
  applies_to_version: '1.1.0',
  source: { url: 'https://x.test/1', type: 'forum', date: '2026-11-10', retrieved: '2026-11-24' },
  provenance: { extracted_by: 'model:m', extracted: '2026-11-24', reviewed_by: null },
  ...over,
}) as Claim;
const needs = (scores: Partial<Record<(typeof NEED_DIMENSIONS)[number], number | null>>, evidence: Partial<Record<(typeof NEED_DIMENSIONS)[number], string[]>> = {}): NeedsAssessment =>
  ({
    bip: 352,
    assessed: '2026-11-20',
    provenance: { extracted_by: 'model:m', extracted: '2026-11-20', reviewed_by: null },
    dimensions: Object.fromEntries(NEED_DIMENSIONS.map((d) => [d, { score: scores[d] ?? 5, rationale: '', evidence: evidence[d] ?? [] }])),
  }) as NeedsAssessment;
const bundle = (status: string, nd: NeedsAssessment | null): BipBundle =>
  ({ bip: { number: 352, title: 't', status, version: '1.1.0', bipwatch: { tracked: true } }, claims: [], needs: nd }) as unknown as BipBundle;

describe('weak dimensions', () => {
  it('takes scores of 2 or less that have types of work', () => {
    expect(weakDimensions(bundle('Complete', needs({ implementations: 1, ux_exploration: 2, problem_evidence: 0 })))).toEqual(['ux_exploration', 'implementations']);
  });
  it('falls back to the lowest score below 4, else none', () => {
    expect(weakDimensions(bundle('Complete', needs({ coordination: 3 })))).toEqual(['coordination']);
    expect(weakDimensions(bundle('Complete', needs({})))).toEqual([]);
    expect(weakDimensions(bundle('Complete', null))).toEqual([]);
  });
});

describe('triage', () => {
  const t = triager(bundle('Complete', needs({ implementations: 1, technical_maturity: 3 }, { technical_maturity: ['cited'] })), today);

  it('puts fresh work behind a weak score first', () => {
    expect(t(claim({}))).toEqual({ tier: 'attention', reasons: ['Holds back Implementations (1/5)', 'Raised 2 weeks ago'] });
  });
  it('keeps quiet work behind a weak score as important', () => {
    expect(t(claim({ source: { url: 'u', type: 'forum', date: '2026-03-01', retrieved: 'r' } })).tier).toBe('important');
  });
  it('counts items cited for a score that is not yet good', () => {
    expect(t(claim({ id: 'cited', area: 'design' })).reasons[0]).toBe('Behind the Technical maturity (3/5) score');
  });
  it('lets the rest wait, including undated spec items', () => {
    expect(t(claim({ area: 'design' })).tier).toBe('later');
    expect(t(claim({ area: 'design', source: { url: 'u', type: 'spec', retrieved: 'r' } }))).toEqual({ tier: 'later', reasons: ['From the spec text'] });
  });
  it('marks old items and items on an older spec as maybe outdated, before anything else', () => {
    expect(t(claim({ source: { url: 'u', type: 'forum', date: '2023-01-01', retrieved: 'r' } })).tier).toBe('outdated');
    expect(t(claim({ applies_to_version: '1.0.0' })).reasons[0]).toMatch(/^Raised on spec v1\.0\.0/);
    // A companion piece has its own versions; the BIP's version says nothing about it.
    expect(t(claim({ applies_to_version: '1.0.0', part_of: 'light-client index' })).tier).toBe('attention');
  });
  it('treats objections and open questions on a draft as holding it back', () => {
    const d = triager(bundle('Draft', null), today);
    expect(d(claim({ kind: 'objection', area: 'design' }))).toEqual({ tier: 'attention', reasons: ['Objection to a draft', 'Raised 2 weeks ago'] });
    expect(d(claim({ kind: 'task', area: 'design' })).tier).toBe('later');
  });
});

describe('a person\'s choice', () => {
  const t = triager(bundle('Complete', needs({ implementations: 1 })), today);
  const p = { tier: 'later' as const, by: 'nuno', on: '2026-11-20', note: 'Waits for the index spec' };

  it('wins over the rules, with who and why as the reasons', () => {
    expect(t(claim({ priority: p }))).toEqual({ tier: 'later', reasons: ['Set by nuno on 2026-11-20', 'Waits for the index spec'], chosen: { by: 'nuno', on: '2026-11-20', note: 'Waits for the index spec' } });
  });

  it('sets the whole topic, the latest choice winning', () => {
    const a = claim({ id: 'ta' });
    const b = claim({ id: 'tb', priority: p });
    const c = claim({ id: 'tc', priority: { tier: 'important', by: 'ann', on: '2026-11-22' } });
    const lone = claim({ id: 'lone' });
    const map = new Map<string, Triage>([a, b, c, lone].map((x) => [x.id, t(x)]));
    const topics = { bip: 352, grouped: '2026-11-24', provenance: { extracted_by: 'model:m', extracted: '2026-11-24', reviewed_by: null }, topics: [{ id: 'x', title: 'Same thing here', items: ['ta', 'tb', 'tc'] }] };
    withTopicChoices(map, [a, b, c, lone], topics);
    expect(['ta', 'tb', 'tc'].map((id) => map.get(id)!.tier)).toEqual(['important', 'important', 'important']);
    expect(map.get('ta')!.reasons[0]).toBe('Set by ann on 2026-11-22');
    expect(map.get('lone')!.tier).toBe('attention');
  });
});
