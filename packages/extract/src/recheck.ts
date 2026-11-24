import type { BipRecord, Claim } from '@bipwatch/data';
import { z } from 'zod';

/**
 * Recheck (triage step 4): is open work still open? An item's status was
 * judged once, when it was extracted. This reads what came after: the later
 * messages in the item's thread and the current spec text. The model may mark
 * an item addressed only by quoting, verbatim, the message or spec passage
 * that shows it; code checks the quote is really there before anything is
 * written. Everything else stays open. Items come in batches: one per thread
 * with new messages, and (with --spec) batches of items raised on an older
 * spec version, checked against the current text alone.
 */

export const RECHECK_VERSION = 1;
export const RECHECK_MODEL = 'claude-opus-5-5';
export const WORK = ['task', 'open-question', 'objection'];
const MAX_MESSAGE_CHARS = 2500;
const MAX_SPEC_CHARS = 120_000;
export const SPEC_BATCH = 12;

export interface LaterMessage {
  url: string;
  author: string;
  date?: string;
  text: string;
}

export interface Batch {
  bip: number;
  /** Thread key, or 'spec' for a batch checked against the spec alone. */
  thread: string;
  items: Claim[];
  messages: LaterMessage[];
}

/** Open work that a recheck may close: open or unknown, with a source to start from. */
export const recheckable = (c: Claim) => WORK.includes(c.kind) && c.status !== 'addressed' && !c.resolution;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function recheckSystem(bip: BipRecord, specText: string | undefined): string {
  return `You check whether open work on a Bitcoin Improvement Proposal has since been addressed, for BipWatch, a public site that lists the work that would move each BIP forward. Each item is a task, open question or objection someone raised in public discussion. Since then, the thread may have gone on and the spec may have changed.

You get a batch of items, each with the date it was raised and the words it was raised in, and the messages posted later in the same thread, numbered. The current text of BIP ${bip.number} (${bip.title}) is below.

For each item, decide:
- addressed: something after it settles it. The task was done, the question was answered and the answer accepted, the objection was resolved or withdrawn, or the spec now says what the item asked for. Give the evidence: the number of the message, or "spec", and a quote copied exactly from it, one or two sentences that show it is settled.
- open: nothing shows it settled. This includes replies that only agree, discuss, promise to do it later, or disagree. A message posted before the item was raised cannot settle it.

Be strict: an item marked addressed disappears from the list of open work, so mark it only when the quote alone would convince a reader. When unsure, it is open. Answer for every item in the batch.

<spec bip="${bip.number}" revision="${bip.spec.revision.slice(0, 7)}">
${specText ? clip(specText, MAX_SPEC_CHARS) : '(not available)'}
</spec>`;
}

export function recheckMessage(b: Batch): string {
  const items = b.items.map((c) =>
    [
      `[${c.id}] ${c.kind}, raised ${c.source.date ?? 'on an unknown date'}${c.applies_to_version ? ` against spec v${c.applies_to_version}` : ''}${c.part_of ? `, about ${c.part_of}` : ''}:`,
      `  ${oneLine(c.statement)}`,
      ...(c.source.quote ? [`  Raised as: "${oneLine(c.source.quote)}"`] : []),
    ].join('\n'),
  );
  const messages = b.messages.length
    ? b.messages.map((m, i) => `<message n="${i + 1}" author="${m.author}" date="${m.date ?? '?'}">\n${clip(m.text, MAX_MESSAGE_CHARS)}\n</message>`)
    : ['(No later messages: judge these against the current spec text only.)'];
  return ['Items:', ...items, '', 'Later messages in the thread, oldest first:', ...messages].join('\n');
}

export const RecheckOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['addressed', 'open']),
      evidence: z.union([z.number().int(), z.literal('spec')]).nullable(),
      quote: z.string().nullable(),
    }),
  ),
});
export type RecheckOutput = z.infer<typeof RecheckOutput>;

/** For matching a quote: case, whitespace, curly quotes and dashes do not count. */
export const normalize = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** The text a piece of evidence points at, as the model saw it. */
export function evidenceText(b: Batch, evidence: number | 'spec', specText: string | undefined): string | undefined {
  if (evidence === 'spec') return specText ? clip(specText, MAX_SPEC_CHARS) : undefined;
  const m = b.messages[evidence - 1];
  return m ? clip(m.text, MAX_MESSAGE_CHARS) : undefined;
}

/** Problems with the model's answer, for one retry. */
export function checkRecheck(out: RecheckOutput, b: Batch, specText: string | undefined): string[] {
  const errors: string[] = [];
  const want = new Set(b.items.map((c) => c.id));
  const got = new Set<string>();
  for (const it of out.items) {
    if (!want.has(it.id)) {
      errors.push(`unknown id "${it.id}"; copy ids exactly`);
      continue;
    }
    got.add(it.id);
    if (it.status !== 'addressed') continue;
    if (it.evidence === null || !it.quote) {
      errors.push(`${it.id}: addressed needs evidence (a message number or "spec") and a quote`);
      continue;
    }
    const text = evidenceText(b, it.evidence, specText);
    if (!text) errors.push(`${it.id}: evidence ${it.evidence} does not exist in this batch`);
    else if (it.quote.length < 20 || it.quote.length > 600) errors.push(`${it.id}: the quote must be 20 to 600 characters`);
    else if (!normalize(text).includes(normalize(it.quote))) errors.push(`${it.id}: the quote is not in ${it.evidence === 'spec' ? 'the spec' : `message ${it.evidence}`}; copy it exactly`);
    else if (it.evidence !== 'spec') {
      const m = b.messages[it.evidence - 1];
      const raised = b.items.find((c) => c.id === it.id)!.source.date;
      if (m.date && raised && m.date < raised) errors.push(`${it.id}: message ${it.evidence} was posted before the item was raised`);
    }
  }
  for (const id of want) if (!got.has(id)) errors.push(`no answer for "${id}"`);
  return errors;
}

export interface Resolved {
  claim: Claim;
  resolution: NonNullable<Claim['resolution']>;
}

/** Items the answer closes, keeping only those whose evidence passes on its own. */
export function resolved(out: RecheckOutput, b: Batch, bip: BipRecord, specText: string | undefined, model: string, today: string): Resolved[] {
  const byId = new Map(b.items.map((c) => [c.id, c]));
  const res: Resolved[] = [];
  for (const it of out.items) {
    const claim = byId.get(it.id);
    if (!claim || it.status !== 'addressed') continue;
    if (checkRecheck({ items: [it] }, { ...b, items: [claim] }, specText).length) continue;
    const m = it.evidence === 'spec' ? null : b.messages[(it.evidence as number) - 1];
    res.push({
      claim,
      resolution: {
        url: m ? m.url : `https://github.com/bitcoin/bips/blob/${bip.spec.revision}/${bip.spec.path}`,
        quote: oneLine(it.quote!),
        ...(m?.date ? { date: m.date } : {}),
        found_by: `model:${model}`,
        found: today,
      },
    });
  }
  return res;
}

/** The claim as written back: addressed, with the evidence. */
export const closeClaim = (r: Resolved): Claim => ({ ...r.claim, status: 'addressed', resolution: r.resolution });

/** Items raised against an older spec version than the current one, in batches, for --spec. */
export function specBatches(bip: BipRecord, items: Claim[], isStale: (v: string | undefined) => boolean): Batch[] {
  const stale = items.filter((c) => !c.part_of && isStale(c.applies_to_version));
  const out: Batch[] = [];
  for (let i = 0; i < stale.length; i += SPEC_BATCH) out.push({ bip: bip.number, thread: 'spec', items: stale.slice(i, i + SPEC_BATCH), messages: [] });
  return out;
}

const minor = (v: string) => v.split('.').slice(0, 2).map(Number);
/** Raised against an older MAJOR.MINOR than the current spec (the site's isStale). */
export function olderSpec(madeAgainst: string | undefined, current: string | undefined): boolean {
  if (!madeAgainst || !current) return false;
  const [a1, a2] = minor(madeAgainst);
  const [c1, c2] = minor(current);
  return a1 < c1 || (a1 === c1 && a2 < c2);
}
