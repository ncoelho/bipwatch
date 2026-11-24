import { describe, expect, it } from 'vitest';
import type { Topics } from '@bipwatch/data';
import { raisedLabel, topicRows } from '../src/lib/topics.ts';

const topics: Topics = {
  bip: 352,
  grouped: '2026-11-24',
  provenance: { extracted_by: 'model:m', extracted: '2026-11-24', reviewed_by: null },
  topics: [{ id: 'fix-vectors', title: 'Fix the test vectors', items: ['b', 'd', 'e'] }],
};
const items = [
  { id: 'a', who: 'Ann' },
  { id: 'b', who: 'Bob' },
  { id: 'c', who: 'Cy' },
  { id: 'd', who: 'Dee' },
  { id: 'e', who: 'Bob' },
];

describe('topic rows', () => {
  it('folds a topic into its first item, in list order', () => {
    const rows = topicRows(items, topics, (i) => i.who);
    expect(rows.map((r) => [r.lead.id, r.others.map((o) => o.id)])).toEqual([['a', []], ['b', ['d', 'e']], ['c', []]]);
    expect(rows[1]).toMatchObject({ topic: { id: 'fix-vectors', title: 'Fix the test vectors' }, people: 2 });
    expect(raisedLabel(rows[1])).toBe('Raised 3 times by 2 people');
    expect(raisedLabel(rows[0])).toBe('');
  });
  it('leaves every item alone without topics, and ignores ids not in the list', () => {
    expect(topicRows(items, null, (i) => i.who)).toHaveLength(5);
    expect(topicRows(items.slice(0, 2), topics, (i) => i.who).map((r) => r.others.length)).toEqual([0, 0]);
  });
});
