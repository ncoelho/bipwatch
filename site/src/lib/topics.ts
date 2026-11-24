// Topics (triage step 2): open work items that ask for the same thing, from
// bips/<NNNN>/topics.yaml, shown once. A topic's row leads with its best
// member (highest priority group, then newest) and carries the others, so
// "raised 4 times by 3 people" replaces four rows. Items in no topic stand
// alone. Pure; the pages render the result.
import type { Topics } from '@bipwatch/data';

export interface TopicRow<T> {
  lead: T;
  /** The topic's other items, best first; empty for an item on its own. */
  others: T[];
  topic?: { id: string; title: string };
  /** Distinct people (or projects) who raised it. */
  people: number;
}

/**
 * Rows for a list of items, in the order of their leads. `items` must already
 * be in display order (best first); `who` names who raised an item.
 */
export function topicRows<T extends { id: string }>(items: T[], topics: Topics | null | undefined, who: (i: T) => string): TopicRow<T>[] {
  const topicOf = new Map<string, Topics['topics'][number]>();
  for (const t of topics?.topics ?? []) for (const id of t.items) topicOf.set(id, t);
  const rows: TopicRow<T>[] = [];
  const byTopic = new Map<string, TopicRow<T>>();
  for (const i of items) {
    const t = topicOf.get(i.id);
    const row = t && byTopic.get(t.id);
    if (row) {
      row.others.push(i);
      continue;
    }
    const fresh: TopicRow<T> = { lead: i, others: [], people: 0, ...(t ? { topic: { id: t.id, title: t.title } } : {}) };
    rows.push(fresh);
    if (t) byTopic.set(t.id, fresh);
  }
  for (const r of rows) r.people = new Set([r.lead, ...r.others].map(who)).size;
  return rows;
}

/** "Raised 4 times by 3 people", or '' for an item on its own. */
export const raisedLabel = (r: TopicRow<unknown>) =>
  r.others.length ? `Raised ${r.others.length + 1} times${r.people > 1 ? ` by ${r.people} people` : ''}` : '';
