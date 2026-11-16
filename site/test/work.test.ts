import { describe, expect, it } from 'vitest';
import type { BipBundle, Claim } from '@bipwatch/data';
import { age, gridRows, isOld, mapLead, pieceKey, piecesLead, sortItems, topPieces, usedAreas, workItems, workStats } from '../src/lib/work.ts';

const today = new Date('2026-11-16T12:00:00Z');
let n = 0;
const claim = (over: Partial<Claim>): Claim => ({
  id: `c${++n}`,
  bip: 352,
  kind: 'task',
  status: 'open',
  area: 'design',
  statement: 'Do a thing.',
  subject: { name: 'theStack', type: 'person' },
  applies_to_version: '1.1.2',
  source: { url: 'https://x.test/1', type: 'forum', date: '2026-11-10', retrieved: '2026-11-16', quote: 'q', verified: true },
  provenance: { extracted_by: 'model:m', extracted: '2026-11-16', reviewed_by: null },
  ...over,
}) as Claim;
const bundle = (num: number, tracked: boolean, claims: Claim[], version = '1.1.2'): BipBundle => ({
  bip: { number: num, title: `BIP ${num} title`, status: 'Complete', version, bipwatch: { tracked } } as BipBundle['bip'],
  claims,
  needs: null,
});
const canonical = (s: string) => (s === 'theStack' ? 'Sebastian Falbesoner' : s);

const b352 = bundle(352, true, [
  claim({ id: 'new', source: { url: 'u', type: 'forum', date: '2026-11-10', retrieved: 'r' } }),
  claim({ id: 'older', kind: 'open-question', area: 'research', part_of: 'light-client index', source: { url: 'u', type: 'github', date: '2023-01-01', retrieved: 'r' } }),
  claim({ id: 'spec', kind: 'objection', area: undefined, status: 'unknown', source: { url: 'u', type: 'spec', retrieved: 'r' } }),
  claim({ id: 'done', status: 'addressed' }),
  claim({ id: 'stale', applies_to_version: '1.0.0', subject: undefined }),
  claim({ id: 'stance', kind: 'stance' }),
]);
const b54 = bundle(54, true, [claim({ id: 'x54', bip: 54, area: 'activation', source: { url: 'u', type: 'forum', date: '2026-10-01', retrieved: 'r' } })]);
const b22 = bundle(22, true, []);
const b375 = bundle(375, false, [claim({ id: 'untracked', bip: 375 })]);
const all = [b352, b54, b22, b375];
const items = workItems(all, canonical, today);

describe('work items', () => {
  it('takes open and unknown work on tracked BIPs only', () => {
    expect(items.map((i) => i.id).sort()).toEqual(['new', 'older', 'spec', 'stale', 'x54']);
    expect(items.find((i) => i.id === 'spec')).toMatchObject({ status: 'unknown', area: '', areaLabel: 'Not sorted yet' });
  });

  it('names people canonically, or the authors', () => {
    expect(items.find((i) => i.id === 'new')!.who).toBe('Sebastian Falbesoner');
    expect(items.find((i) => i.id === 'stale')!.who).toBe('the authors');
  });

  it('keys pieces per BIP and links to the item on the BIP page', () => {
    expect(items.find((i) => i.id === 'older')).toMatchObject({ piece: 'light-client index', pieceKey: '352|light-client index' });
    expect(items.find((i) => i.id === 'new')!.pieceKey).toBe(pieceKey(352, ''));
    expect(items.find((i) => i.id === 'new')!.bipHref).toBe('/bip/352/#needs?item=new');
  });

  it('flags old items (over 2 years, dated only) and stale ones', () => {
    expect(items.find((i) => i.id === 'older')!.old).toBe(true);
    expect(items.find((i) => i.id === 'spec')!.old).toBe(false);
    expect(isOld('2024-11-17', today)).toBe(false);
    expect(isOld('2024-11-15', today)).toBe(true);
    expect(items.find((i) => i.id === 'stale')).toMatchObject({ stale: true, staleLabel: 'spec v1.0.0' });
    expect(items.find((i) => i.id === 'new')!.stale).toBe(false);
  });
});

describe('sorting and ages', () => {
  it('sorts newest and oldest with undated last, and by BIP then piece', () => {
    expect(sortItems(items, 'new').map((i) => i.id)).toEqual(['new', 'stale', 'x54', 'older', 'spec']);
    expect(sortItems(items, 'old').map((i) => i.id)).toEqual(['older', 'x54', 'new', 'stale', 'spec']);
    expect(sortItems(items, 'bip').map((i) => i.id)).toEqual(['x54', 'new', 'stale', 'spec', 'older']);
  });

  it('formats ages in days, weeks, months and years', () => {
    expect(age('2026-11-10', today)).toBe('6d');
    expect(age('2026-10-01', today)).toBe('6 wk');
    expect(age('2025-11-01', today)).toBe('12 mo');
    expect(age('2023-01-01', today)).toBe('3.9 yr');
    expect(age(undefined, today)).toBe('in the spec');
  });
});

describe('counts', () => {
  it('counts the page-level numbers', () => {
    const s = workStats(items, all, today);
    expect(s).toMatchObject({ open: 5, tasks: 3, questions: 1, objections: 1, tracked: 3, withOpen: 2, nothingOpen: [22], recent: 2, newest: '2026-11-10', old: 1, oldByBip: [[352, 1]], addressed: 1, pending: true });
  });

  it('builds the grid, top pieces and leads from the same items', () => {
    const areas = usedAreas(items);
    expect(areas).toEqual(['design', 'research', 'activation', '']);
    const rows = gridRows(items, all, areas);
    expect(rows.map((r) => [r.bip, r.open])).toEqual([[352, 4], [54, 1], [22, 0]]);
    expect(rows[0].cells.find((c) => c.area === 'design')!.n).toBe(2);
    expect(rows[0].needs).toEqual([null, null, null, null, null, null]);
    expect(topPieces(items)[0]).toMatchObject({ key: '352|', open: 3 });
    expect(mapLead(items, rows, areas)).toMatch(/^BIP 352 holds 80% of the open work\. Protocol design is the biggest need \(2 items\)\./);
    expect(piecesLead(items)).toMatch(/^Only 4 of 5 open items/);
  });
});
