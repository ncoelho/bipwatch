import type { BipBundle, Claim, Topics } from '@bipwatch/data';
import { stringify } from 'yaml';
import { z } from 'zod';

/**
 * Topics (triage step 2): open work items that ask for the same thing, so a
 * reader sees each request once ("raised 4 times by 3 people"). The model
 * reads one line per open item, grouped by the piece it belongs to, and
 * proposes groups; code checks every id, keeps each group on one piece and
 * each item in one group, and the file reaches main through a pull request.
 * Grouping needs reading the statements, so it is a model step; the site
 * only uses the result.
 */

export const TOPICS_MODEL = 'claude-opus-5-5';
export const WORK = ['task', 'open-question', 'objection'];

export const TOPICS_SYSTEM = `You group duplicate requests for BipWatch, a public site that lists the open work on Bitcoin Improvement Proposals: tasks, open questions and objections raised in public discussion. The same request is often raised several times, by different people or in different threads, in different words. You get one line per open item, under the piece of work it belongs to (the BIP itself, a companion BIP, or a project built for it). Each line starts with the item's id in brackets.

Group items only when one piece of work, done once, would settle every item in the group: the same fix, the same question, the same objection. Items that are merely about the same subject or the same part of the spec stay apart. When unsure, leave an item alone; a missed group costs little, a wrong one hides work.

Return topics:
- items: the ids in the group, copied exactly, two or more, all from the same piece. An id goes in at most one topic.
- title: one plain sentence under 140 characters naming the shared request, as a task a contributor could pick up ("Fix the test vectors that are consensus-invalid"). Do not mention the people, the count or BipWatch.

Items that belong to no group are left out. Return an empty list when nothing repeats.`;

export const TopicsOutput = z.object({ topics: z.array(z.object({ title: z.string(), items: z.array(z.string()) })) });
export type TopicsOutput = z.infer<typeof TopicsOutput>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();
export const openWork = (b: BipBundle) => b.claims.filter((c) => WORK.includes(c.kind) && c.status !== 'addressed');
const pieceOf = (c: Claim, n: number) => c.part_of ?? `BIP ${n} itself`;

/** One line per open item, under its piece; pieces with a single item are left out. */
export function topicsDigest(b: BipBundle): string {
  const n = b.bip.number;
  const byPiece = new Map<string, Claim[]>();
  for (const c of openWork(b)) byPiece.set(pieceOf(c, n), [...(byPiece.get(pieceOf(c, n)) ?? []), c]);
  const lines = [`BIP ${n}: ${b.bip.title}`];
  for (const [piece, list] of [...byPiece].sort((x, y) => y[1].length - x[1].length)) {
    if (list.length < 2) continue;
    lines.push('', `## ${piece} (${list.length})`);
    for (const c of list) lines.push(`[${c.id}] ${c.kind} · ${c.area ?? 'no type'}: ${clip(c.statement, 260)}`);
  }
  return lines.join('\n');
}

/** Problems with the model's groups, for one retry. */
export function checkTopics(out: TopicsOutput, b: BipBundle): string[] {
  const open = new Map(openWork(b).map((c) => [c.id, c]));
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, t] of out.topics.entries()) {
    const name = `topic ${i + 1} ("${clip(t.title, 50)}")`;
    if (t.items.length < 2) errors.push(`${name}: a topic needs two or more items`);
    if (t.title.trim().length < 10 || t.title.length > 160) errors.push(`${name}: the title must be 10 to 160 characters`);
    const pieces = new Set<string>();
    for (const id of t.items) {
      const c = open.get(id);
      if (!c) errors.push(`${name}: unknown id "${id}"; copy ids exactly from the digest`);
      else pieces.add(pieceOf(c, b.bip.number));
      if (seen.has(id)) errors.push(`${name}: "${id}" is already in another topic`);
      seen.add(id);
    }
    if (pieces.size > 1) errors.push(`${name}: mixes pieces (${[...pieces].join(', ')}); a topic stays on one piece`);
  }
  return errors;
}

/** Keep only the groups that pass on their own, for when the retry still fails. */
export function validTopics(out: TopicsOutput, b: BipBundle): TopicsOutput {
  const kept: TopicsOutput['topics'] = [];
  for (const t of out.topics) {
    const trial = { topics: [...kept, { ...t, items: [...new Set(t.items)] }] };
    if (!checkTopics(trial, b).length) kept.push(trial.topics.at(-1)!);
  }
  return { topics: kept };
}

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'topic';

export function toTopics(out: TopicsOutput, bip: number, today: string, model: string): Topics {
  const used = new Set<string>();
  const topics = out.topics.map((t) => {
    let id = slug(t.title);
    for (let k = 2; used.has(id); k++) id = `${slug(t.title).slice(0, 56)}-${k}`;
    used.add(id);
    return { id, title: t.title.trim().replace(/\s+/g, ' '), items: [...new Set(t.items)] };
  });
  return { bip, grouped: today, provenance: { extracted_by: `model:${model}`, extracted: today, reviewed_by: null }, topics };
}

export function topicsYaml(t: Topics): string {
  return [
    '# Open work items that ask for the same thing, grouped by `npm run topics`;',
    '# pending review. Items not listed here stand alone.',
    stringify(t, { lineWidth: 100 }),
  ].join('\n');
}
