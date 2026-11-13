import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalName, loadPeople, WORK_AREAS, type Claim } from '@bipwatch/data';
import { z } from 'zod';
import { slug, SOURCE_LABEL, SOURCE_TYPE, type Task } from '../../task.ts';

/**
 * Open work (SPEC 1, "the main job"): tasks, open questions and objections a
 * document raises about a tracked BIP, each with the area of work and
 * whether it is still open. The author who raised it is the subject (set by
 * code). Later replies in the same thread are shown to the model only so it
 * can tell whether the item was resolved; the quote must come from the
 * document itself, which the validator checks.
 */

export const WORK_KINDS = ['task', 'open-question', 'objection'] as const;

export const WorkOutput = z.object({
  items: z.array(
    z.object({
      bip: z.number().int(),
      kind: z.enum(WORK_KINDS),
      area: z.enum(WORK_AREAS),
      part_of: z.string().nullable(),
      status: z.enum(['open', 'addressed']),
      statement: z.string(),
      quote: z.string(),
    }),
  ),
});
export type WorkOutput = z.infer<typeof WorkOutput>;

// v2 (2026-11-13): judges status against the current spec text as well as
// later replies, and leaves companion BIPs' work to them.
// v3 (2026-11-13): records companion and ecosystem work too (PSBT fields,
// light-client index, wallet support), named in part_of, since untracked
// companions would otherwise hide the work that moves the BIP forward.
// v4 (2026-11-13): areas are types of work by contributor; "spec" splits
// into design (deciding how it works) and writing (editing the document).
const VERSION = 4;
const MAX_SPEC_CHARS = 120_000;
const MAX_COMPANION_CHARS = 60_000;

/** Comparison key for part_of names: case, spaces and hyphens ignored. */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * part_of as written: "BIP 375" for numbered BIPs; otherwise the spelling
 * already in use when one matches, else lower case with "light client"
 * hyphenated. Null when it names the BIP itself.
 */
export function normalisePartOf(raw: string | null | undefined, bip: number, known: Iterable<string>): string | null {
  const v = raw?.trim().replace(/\s+/g, ' ');
  if (!v) return null;
  const num = v.match(/^BIP[ -]?0*(\d+)$/i);
  if (num) return Number(num[1]) === bip ? null : `BIP ${Number(num[1])}`;
  for (const k of known) if (nameKey(k) === nameKey(v)) return k;
  return v.toLowerCase().replace(/\blight client\b/g, 'light-client');
}

// Names used so far, per BIP: seeded from existing claims, grown during a run
// so later documents reuse the names earlier ones introduced.
const namesInUse = new Map<number, Set<string>>();
const names = (bip: number, seed: string[] = []) => {
  let set = namesInUse.get(bip);
  if (!set) namesInUse.set(bip, (set = new Set(seed)));
  return set;
};
const system = readFileSync(new URL(`./prompt.v${VERSION}.md`, import.meta.url), 'utf8');
const canonical = canonicalName(loadPeople());

export const workTask: Task<WorkOutput> = {
  id: 'work',
  version: VERSION,
  // v4 only renamed areas, so it carries on where v3 stopped.
  continuesFrom: [3],
  kind: 'task',
  model: 'claude-opus-5-5',
  effort: 'medium',
  system,
  schema: WorkOutput,
  maxDocChars: 60_000,
  // Commit messages in the BIPs repo say what was changed, never what is
  // left to do; the current spec text already reflects them.
  skipSources: ['bips-repo'],

  context(bips) {
    return bips
      .map(({ bip, specText, companions: texts = [] }) => {
        const companions = [...(bip.related ?? []), ...(bip.requires ?? [])];
        const text = specText ? specText.slice(0, MAX_SPEC_CHARS) : '(not available)';
        return [
          `Current text of BIP ${bip.number} (${bip.title}), revision ${bip.spec.revision.slice(0, 7)}, for judging status:`,
          companions.length ? `Its companion and required BIPs (name one in part_of when work belongs to it): ${companions.map((n) => `BIP ${n}`).join(', ')}.` : null,
          `<spec bip="${bip.number}">`,
          text,
          '</spec>',
          ...texts.flatMap((c) => [
            '',
            `Current text of companion BIP ${c.number}, for judging the status of work that belongs to it:`,
            `<spec bip="${c.number}">`,
            c.text.slice(0, MAX_COMPANION_CHARS),
            '</spec>',
          ]),
        ].filter((l) => l !== null).join('\n');
      })
      .join('\n\n');
  },

  userMessage(doc, bips) {
    return [
      'BIPs this document may raise work on:',
      ...bips.map(({ bip }) => `- BIP ${bip.number}: ${bip.title} (status: ${bip.status})`),
      '',
      `Source: ${SOURCE_LABEL[doc.source]}`,
      `Author: ${doc.author}`,
      `Date: ${doc.posted_at ? doc.posted_at.toISOString().slice(0, 10) : 'unknown'}`,
      ...(doc.thread_title ? [`Thread: ${doc.thread_title}`] : []),
      ...(doc.title && doc.title !== doc.thread_title ? [`Title: ${doc.title}`] : []),
      '',
      ...bips.flatMap(({ bip, workNames }) => {
        const used = [...names(bip.number, workNames)];
        return used.length ? [`part_of names already used for BIP ${bip.number} (reuse one when it fits): ${used.join('; ')}`] : [];
      }),
      '',
      '<document>',
      doc.body_text,
      '</document>',
      '',
      doc.later
        ? `<later_replies>\nLater messages in the same thread, oldest first, shortened. Use them only to judge status; never quote them.\n\n${doc.later}\n</later_replies>`
        : '<later_replies>None archived.</later_replies>',
    ].join('\n');
  },

  toClaims(output, doc, ctx) {
    const author = canonical(doc.author ?? 'unknown');
    return output.items.map((it): Claim => {
      const bip = ctx.bips.get(it.bip);
      const known = names(it.bip, bip?.workNames);
      const part_of = normalisePartOf(it.part_of, it.bip, known);
      if (part_of) known.add(part_of);
      const hash = createHash('sha256').update(`${doc.external_id}\0${it.kind}\0${it.quote}`).digest('hex').slice(0, 8);
      return {
        id: `${it.kind}-${slug(author, 32)}-${hash}`,
        bip: it.bip,
        kind: it.kind,
        status: it.status,
        area: it.area,
        ...(part_of ? { part_of } : {}),
        statement: it.statement.trim(),
        subject: { name: author, type: 'person' },
        ...(bip ? { applies_to_version: bip.versionAt(doc.posted_at) } : {}),
        source: {
          url: doc.url,
          type: SOURCE_TYPE[doc.source],
          ...(doc.title ?? doc.thread_title ? { title: (doc.title ?? doc.thread_title)! } : {}),
          ...(doc.posted_at ? { date: doc.posted_at.toISOString().slice(0, 10) } : {}),
          retrieved: ctx.today,
          quote: it.quote.trim(),
          verified: true,
        },
        provenance: { extracted_by: `model:${ctx.modelId}`, extracted: ctx.today, reviewed_by: null },
      };
    });
  },
};
