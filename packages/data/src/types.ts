// Hand-written to mirror data/schemas/*.schema.json. Keep the two in step;
// the validator is the source of truth for what is allowed.

export type OfficialStatus = 'Draft' | 'Complete' | 'Deployed' | 'Closed';

export type Category =
  | 'idea'
  | 'in-development'
  | 'needs-consensus'
  | 'ready-to-build'
  | 'live-patchy-adoption'
  | 'standard-everywhere'
  | 'fading'
  | 'closed-replaced';

export type Template = 'idea' | 'draft' | 'complete' | 'deployed' | 'closed';

export interface BipRecord {
  number: number;
  title: string;
  layer: string | null;
  type: 'Specification' | 'Informational' | 'Process';
  status: OfficialStatus;
  version?: string;
  assigned?: string;
  license?: string;
  authors: string[];
  requires?: number[];
  related?: number[];
  discussion?: { date?: string; url: string; title?: string }[];
  spec: { repo: 'bitcoin/bips'; path: string; revision: string; synced: string };
  bipwatch: {
    tracked: boolean;
    category?: Category;
    template?: Template;
    adoption_measure?: string;
    summary?: string;
    aliases?: string[];
  };
}

export const WORK_AREAS = ['spec', 'review', 'implementation', 'testing', 'research', 'ux', 'coordination', 'activation'] as const;
export type WorkArea = (typeof WORK_AREAS)[number];

export type ClaimKind =
  | 'problem'
  | 'evidence'
  | 'tradeoff'
  | 'open-question'
  | 'objection'
  | 'task'
  | 'stance'
  | 'implementation'
  | 'adoption';

export interface Provenance {
  extracted_by: string;
  extracted: string;
  reviewed_by: string | null;
  reviewed?: string | null;
}

export interface Claim {
  id: string;
  bip: number;
  kind: ClaimKind;
  statement: string;
  status?: 'open' | 'addressed' | 'disputed' | 'unknown';
  /** Tasks, open questions and objections: the kind of work it calls for. */
  area?: WorkArea;
  stance?: 'concept-ack' | 'approach-ack' | 'ack' | 'nack' | 'conditional' | 'needs-research';
  condition?: string;
  /** Stances only: the proposal, one change to its text, or an implementation. */
  scope?: 'proposal' | 'change' | 'implementation';
  change?: { url: string; title?: string };
  subject?: { name: string; type: string; url?: string };
  implementation?: {
    state: 'shipped' | 'partial' | 'in-review' | 'planned' | 'not-supported' | 'proof-of-concept';
    send?: boolean;
    receive?: boolean;
    scanning?: string;
    platforms?: string[];
  };
  applies_to_version?: string;
  source: {
    url: string;
    type: 'spec' | 'mailing-list' | 'forum' | 'github' | 'release-notes' | 'chain' | 'aggregator' | 'press';
    title?: string;
    date?: string;
    retrieved: string;
    revision?: string;
    quote?: string;
    verified?: boolean;
  };
  provenance: Provenance;
  tags?: string[];
}

export const NEED_DIMENSIONS = [
  'problem_evidence',
  'technical_maturity',
  'ux_exploration',
  'implementations',
  'ecosystem_awareness',
  'coordination',
] as const;

export type NeedDimension = (typeof NEED_DIMENSIONS)[number];

export interface NeedsAssessment {
  bip: number;
  assessed: string;
  provenance: Provenance;
  dimensions: Record<
    NeedDimension,
    { score: number | null; rationale: string; evidence: string[]; help_wanted?: string[] }
  >;
}

export interface BipBundle {
  bip: BipRecord;
  claims: Claim[];
  needs: NeedsAssessment | null;
}

/** data/freshness.json: when each collector last succeeded. Written by
 * `npm run freshness -- --export` at build time; not committed. */
export interface SourceFreshness {
  source: string;
  label: string;
  cadence_minutes: number;
  /** ISO time of the last successful run, null if it never succeeded. */
  last_success: string | null;
  /** True when the last success is older than twice the cadence. */
  stale: boolean;
  documents: number;
  /** What `documents` counts, plural ("posts", "commits to BIPs we follow"). */
  unit?: string;
}

export interface Freshness {
  generated_at: string;
  sources: SourceFreshness[];
}

/** data/people.yaml: one identity per person with several names or logins. */
export interface People {
  people: { name: string; aliases: string[] }[];
}
