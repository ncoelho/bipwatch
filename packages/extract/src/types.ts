import type { BipRecord, Claim } from '@bipwatch/data';

/** One archived document offered to a task, with the tracked BIPs it mentions. */
export interface InputDoc {
  id: number;
  source: 'bips-repo' | 'github' | 'delving' | 'mailing-list';
  external_id: string;
  /** Source thread id; for GitHub "owner/repo#123". */
  thread_key: string | null;
  title: string | null;
  thread_title: string | null;
  author: string | null;
  posted_at: Date | null;
  body_text: string;
  url: string;
  bips: number[];
  /** Later messages in the same thread (author: text), shortened; context only. */
  later?: string | null;
}

/** What a task knows about each BIP it may attribute claims to. */
export interface BipContext {
  bip: BipRecord;
  /** Spec version in force when the document was written (0.0.0 if none). */
  versionAt: (date: Date | null) => string;
  /** The spec's text at its current revision, for tasks that judge against it. */
  specText?: string;
}

/** A claim as the pipeline writes it: full schema, plus where it came from. */
export interface ProposedClaim {
  claim: Claim;
  document_id: number;
}

/**
 * Token usage. input_tokens is all input, cached or not (for reporting);
 * the cache parts say how much of it was a cache read or write, which are
 * billed at 0.1x and 1.25x. See billedTokens for what the budget counts.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type Outcome = 'claims' | 'none' | 'invalid' | 'refusal' | 'too_long' | 'error';

/**
 * What the run budget counts: input weighted as billed (uncached in full,
 * cache writes 1.25x, cache reads 0.1x) plus output. Without the weighting
 * a cached spec in every request would exhaust the budget at a tenth of the
 * intended spend.
 */
export function billedTokens(u: Usage): number {
  const read = u.cache_read_tokens ?? 0;
  const write = u.cache_write_tokens ?? 0;
  const uncached = u.input_tokens - read - write;
  return Math.round(uncached + 1.25 * write + 0.1 * read + u.output_tokens);
}
