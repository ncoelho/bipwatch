import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Claim } from '@bipwatch/data';
import { z } from 'zod';
import { slug, SOURCE_LABEL, SOURCE_TYPE, type Task } from '../../task.ts';

/**
 * Stance extraction, the first SPEC 6.2 task: does the document's author
 * take a position on a tracked BIP? The author becomes the claim's subject
 * (set by code, never by the model), and the spec version in force when the
 * document was written becomes applies_to_version.
 */

export const STANCES = ['concept-ack', 'approach-ack', 'ack', 'nack', 'conditional', 'needs-research'] as const;

export const StanceOutput = z.object({
  stances: z.array(
    z.object({
      bip: z.number().int(),
      stance: z.enum(STANCES),
      condition: z.string().nullable(),
      statement: z.string(),
      quote: z.string(),
    }),
  ),
});
export type StanceOutput = z.infer<typeof StanceOutput>;

const VERSION = 1;
const system = readFileSync(new URL(`./prompt.v${VERSION}.md`, import.meta.url), 'utf8');

export const stanceTask: Task<StanceOutput> = {
  id: 'stance',
  version: VERSION,
  kind: 'stance',
  model: 'claude-opus-5-5',
  effort: 'medium',
  system,
  schema: StanceOutput,
  maxDocChars: 60_000,

  userMessage(doc, bips) {
    const lines = [
      'BIPs this document may take a position on:',
      ...bips.map(({ bip, versionAt }) => {
        const v = versionAt(doc.posted_at);
        return `- BIP ${bip.number}: ${bip.title} (spec version at the time: ${v === '0.0.0' ? 'none yet' : v})`;
      }),
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
    ];
    return lines.join('\n');
  },

  toClaims(output, doc, ctx) {
    return output.stances.map((s): Claim => {
      const bip = ctx.bips.get(s.bip);
      const hash = createHash('sha256').update(`${doc.external_id}\0${s.quote}`).digest('hex').slice(0, 8);
      return {
        id: `stance-${slug(doc.author ?? 'unknown', 32)}-${hash}`,
        bip: s.bip,
        kind: 'stance',
        stance: s.stance,
        ...(s.stance === 'conditional' && s.condition ? { condition: s.condition } : {}),
        statement: s.statement.trim(),
        subject: { name: doc.author ?? 'unknown', type: 'person' },
        // An unknown BIP number fails validation below; any valid version keeps the schema check on the bip.
        applies_to_version: bip ? bip.versionAt(doc.posted_at) : '0.0.0',
        source: {
          url: doc.url,
          type: SOURCE_TYPE[doc.source],
          ...(doc.title ?? doc.thread_title ? { title: (doc.title ?? doc.thread_title)! } : {}),
          ...(doc.posted_at ? { date: doc.posted_at.toISOString().slice(0, 10) } : {}),
          retrieved: ctx.today,
          quote: s.quote.trim(),
          // The validator matches the quote against the archived document;
          // a claim that reaches a file has passed that check.
          verified: true,
        },
        provenance: {
          extracted_by: `model:${ctx.modelId}`,
          extracted: ctx.today,
          reviewed_by: null,
        },
      };
    });
  },
};
