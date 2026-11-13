import type { Claim, ClaimKind } from '@bipwatch/data';
import type { z } from 'zod';
import type { BipContext, InputDoc } from './types.ts';

/** Context a task gets when turning model output into claims. */
export interface ClaimContext {
  bips: Map<number, BipContext>;
  /** YYYY-MM-DD, for source.retrieved and provenance.extracted. */
  today: string;
  /** The model that produced the output, for provenance.extracted_by. */
  modelId: string;
}

/**
 * One extraction task (SPEC 6.2): a versioned prompt, the output shape the
 * model must return, and how that output becomes claims. Tasks never touch
 * the database or the filesystem; the runner does.
 */
export interface Task<Out> {
  id: string;
  /** Bump with every prompt or schema change; recorded on each run. */
  version: number;
  /**
   * Earlier versions whose cursor this one continues from, when a change
   * does not call for re-reading documents they already covered (e.g. only
   * labels were renamed). Normally empty: a new version starts over.
   */
  continuesFrom?: number[];
  kind: ClaimKind;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Stable system prompt (cached across documents). */
  system: string;
  schema: z.ZodType<Out>;
  /**
   * Sources this task never reads, decided by code so no tokens are spent on
   * them (e.g. commit messages record work already done).
   */
  skipSources?: string[];
  /** Documents longer than this are logged as too_long and skipped. */
  maxDocChars: number;
  userMessage(doc: InputDoc, bips: BipContext[]): string;
  /**
   * Extra system text for a run, from the BIPs it covers (e.g. the current
   * spec). Runs are per BIP, so it is the same for every document and is
   * cached with the system prompt.
   */
  context?(bips: BipContext[]): string;
  toClaims(output: Out, doc: InputDoc, ctx: ClaimContext): Claim[];
}

/** Lowercase, dash-separated, safe for ids and file names. */
export function slug(s: string, max = 40): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'x'
  );
}

export const SOURCE_TYPE: Record<InputDoc['source'], Claim['source']['type']> = {
  'bips-repo': 'github',
  github: 'github',
  delving: 'forum',
  'mailing-list': 'mailing-list',
};

export const SOURCE_LABEL: Record<InputDoc['source'], string> = {
  'bips-repo': 'bitcoin/bips commit',
  github: 'GitHub',
  delving: 'Delving Bitcoin post',
  'mailing-list': 'bitcoin-dev mailing list message',
};
