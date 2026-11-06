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
}

/** What a task knows about each BIP it may attribute claims to. */
export interface BipContext {
  bip: BipRecord;
  /** Spec version in force when the document was written (0.0.0 if none). */
  versionAt: (date: Date | null) => string;
}

/** A claim as the pipeline writes it: full schema, plus where it came from. */
export interface ProposedClaim {
  claim: Claim;
  document_id: number;
}

/** Usage counted against the run's token budget. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type Outcome = 'claims' | 'none' | 'invalid' | 'refusal' | 'too_long' | 'error';
