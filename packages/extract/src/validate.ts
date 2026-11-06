import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDataDir, type Claim } from '@bipwatch/data';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { InputDoc } from './types.ts';

/**
 * SPEC 6.2 validator for model output. A proposed claim passes only if:
 * 1. it is valid against data/schemas/claim.schema.json,
 * 2. its source.quote appears verbatim in the document's body_text (only
 *    whitespace is normalized: line wraps differ between archive and source),
 * 3. it is about a tracked BIP the document actually mentions,
 * 4. no existing claim has the same kind, subject and quote.
 * (The document existing in raw_items is guaranteed by the selector's join.)
 */

export type ClaimValidator = (claim: Claim, doc: InputDoc) => string[];

/** Collapses runs of whitespace so a wrapped line still matches. */
export const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Fingerprint used for duplicate detection: SPEC 6.2's kind, subject and
 * quote, plus the source URL, so the same short quote ("ACK") from the same
 * person on two different pull requests is two claims, not a duplicate.
 */
export function claimKey(c: Pick<Claim, 'kind' | 'subject' | 'source'>): string {
  return [
    c.kind,
    normalize(c.subject?.name ?? '').toLowerCase(),
    normalize(c.source.quote ?? ''),
    c.source.url,
  ].join('\u0000');
}

export function schemaValidator(dataDir = findDataDir()) {
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({
    allErrors: true,
    strict: true,
    strictRequired: false,
    allowUnionTypes: true,
  });
  (addFormats as unknown as typeof addFormats.default)(ajv);
  const dir = join(dataDir, 'schemas');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
  }
  const claim = ajv.getSchema('claim.schema.json')!;
  return (c: unknown): string[] =>
    claim(c)
      ? []
      : (claim.errors ?? []).map((e) => `schema: ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

/**
 * Builds the validator for one run. `existing` is every claim already in
 * data/; claims accepted during the run are added through `remember`.
 */
export function makeValidator(existing: Claim[], dataDir?: string) {
  const schema = schemaValidator(dataDir);
  const seen = new Set(existing.map(claimKey));

  const validate: ClaimValidator = (claim, doc) => {
    const errors = [...schema(claim)];
    const quote = claim.source.quote;
    if (!quote) errors.push('quote: missing');
    else if (!normalize(doc.body_text).includes(normalize(quote))) {
      errors.push('quote: not found verbatim in the document; copy an exact span of its text');
    }
    if (!doc.bips.includes(claim.bip)) {
      errors.push(`bip: ${claim.bip} is not one of the tracked BIPs this document mentions (${doc.bips.join(', ')})`);
    }
    if (seen.has(claimKey(claim))) errors.push('duplicate: a claim with the same kind, subject and quote exists');
    return errors;
  };

  return {
    validate,
    remember: (claim: Claim) => seen.add(claimKey(claim)),
  };
}
