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
      status: z.enum(['open', 'addressed']),
      statement: z.string(),
      quote: z.string(),
    }),
  ),
});
export type WorkOutput = z.infer<typeof WorkOutput>;

// v2 (2026-11-13): judges status against the current spec text as well as
// later replies, and leaves companion BIPs' work to them.
const VERSION = 2;
const MAX_SPEC_CHARS = 120_000;
const system = readFileSync(new URL(`./prompt.v${VERSION}.md`, import.meta.url), 'utf8');
const canonical = canonicalName(loadPeople());

export const workTask: Task<WorkOutput> = {
  id: 'work',
  version: VERSION,
  kind: 'task',
  model: 'claude-opus-5-5',
  effort: 'medium',
  system,
  schema: WorkOutput,
  maxDocChars: 60_000,

  context(bips) {
    return bips
      .map(({ bip, specText }) => {
        const companions = [...(bip.related ?? []), ...(bip.requires ?? [])];
        const text = specText ? specText.slice(0, MAX_SPEC_CHARS) : '(not available)';
        return [
          `Current text of BIP ${bip.number} (${bip.title}), revision ${bip.spec.revision.slice(0, 7)}, for judging status:`,
          companions.length ? `Its companion and required BIPs, whose own work is not recorded here: ${companions.map((n) => `BIP ${n}`).join(', ')}.` : '',
          `<spec bip="${bip.number}">`,
          text,
          '</spec>',
        ].filter(Boolean).join('\n');
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
      const hash = createHash('sha256').update(`${doc.external_id}\0${it.kind}\0${it.quote}`).digest('hex').slice(0, 8);
      return {
        id: `${it.kind}-${slug(author, 32)}-${hash}`,
        bip: it.bip,
        kind: it.kind,
        status: it.status,
        area: it.area,
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
