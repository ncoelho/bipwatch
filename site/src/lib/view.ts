// Labels and small helpers shared by pages. All data comes from @bipwatch/data.
import { NEED_DIMENSIONS, WORK_AREAS, type BipBundle, type Category, type Claim, type NeedDimension, type WorkArea } from '@bipwatch/data';

export const CATEGORY_LABEL: Record<Category, string> = {
  idea: 'Idea',
  'in-development': 'In development',
  'needs-consensus': 'Needs consensus',
  'ready-to-build': 'Ready to build',
  'live-patchy-adoption': 'Live, patchy adoption',
  'standard-everywhere': 'Standard everywhere',
  fading: 'Fading',
  'closed-replaced': 'Closed or replaced',
};

export const DIMENSION_LABEL: Record<NeedDimension, string> = {
  problem_evidence: 'Problem evidence',
  technical_maturity: 'Technical maturity',
  ux_exploration: 'UX exploration',
  implementations: 'Implementations',
  ecosystem_awareness: 'Ecosystem awareness',
  coordination: 'Coordination',
};

export const STATE_LABEL: Record<string, string> = {
  shipped: 'Shipped',
  partial: 'Partial',
  merged: 'Merged, not released',
  'in-review': 'In review',
  planned: 'Planned',
  'not-supported': 'Not supported',
  'proof-of-concept': 'Proof of concept',
};

export const STATE_ORDER = ['shipped', 'merged', 'partial', 'proof-of-concept', 'in-review', 'planned', 'not-supported'];

export const SOURCE_LABEL: Record<Claim['source']['type'], string> = {
  spec: 'Spec',
  'mailing-list': 'Mailing list',
  forum: 'Forum',
  github: 'GitHub',
  'release-notes': 'Release notes',
  chain: 'Chain data',
  aggregator: 'Aggregator',
  press: 'Press',
};

export const isSecondary = (c: Claim) => c.source.type === 'aggregator' || c.source.type === 'press';
export const isPending = (c: { provenance: { reviewed_by: string | null } }) => c.provenance.reviewed_by === null;

export const byKind = (b: BipBundle, ...kinds: Claim['kind'][]) => b.claims.filter((c) => kinds.includes(c.kind));

export const pad = (n: number) => String(n).padStart(4, '0');
export const bipHref = (n: number) => `/bip/${n}/`;

// ---- open work (SPEC 1, the main job) -----------------------------------------

export const WORK_KINDS: Claim['kind'][] = ['task', 'open-question', 'objection'];

export const WORK_KIND_LABEL: Record<string, string> = { task: 'Task', 'open-question': 'Open question', objection: 'Objection' };

export const AREA_LABEL: Record<WorkArea, string> = {
  design: 'Protocol design',
  writing: 'Spec writing',
  engineering: 'Engineering',
  testing: 'Testing',
  review: 'Review',
  research: 'Research',
  ux: 'UX and design',
  coordination: 'Coordination',
  activation: 'Activation',
};

/** Work on one piece (the BIP itself when part_of is null) within a type of work. */
export interface WorkPiece { part_of: string | null; open: Claim[]; addressed: Claim[]; }
export interface WorkGroup { area: WorkArea | null; open: number; addressed: number; pieces: WorkPiece[]; }

/**
 * Tasks, open questions and objections grouped by type of work, in the
 * schema's order (unassigned last, types with nothing open after the rest),
 * then by piece: the BIP itself first, then the piece with most open work.
 * Within a piece, open items newest first; addressed and disputed ones are
 * kept apart so the page leads with what is left to do.
 */
export function openWork(claims: Claim[]): WorkGroup[] {
  const items = claims.filter((c) => WORK_KINDS.includes(c.kind));
  const newest = (a: Claim, b: Claim) => (b.source.date ?? '').localeCompare(a.source.date ?? '');
  const isOpen = (c: Claim) => c.status !== 'addressed';
  return [...WORK_AREAS, null]
    .map((area): WorkGroup => {
      const inArea = items.filter((c) => (c.area ?? null) === area).sort(newest);
      const parts = [...new Set(inArea.map((c) => c.part_of ?? null))];
      const pieces = parts
        .map((part_of) => {
          const mine = inArea.filter((c) => (c.part_of ?? null) === part_of);
          return { part_of, open: mine.filter(isOpen), addressed: mine.filter((c) => !isOpen(c)) };
        })
        .sort((a, b) =>
          Number(a.part_of !== null) - Number(b.part_of !== null) ||
          b.open.length - a.open.length ||
          b.addressed.length - a.addressed.length ||
          (a.part_of ?? '').localeCompare(b.part_of ?? ''),
        );
      const open = pieces.reduce((n, p) => n + p.open.length, 0);
      return { area, open, addressed: inArea.length - open, pieces };
    })
    .filter((g) => g.pieces.length > 0)
    .sort((a, b) => Number(b.open > 0) - Number(a.open > 0));
}

/** Public JSON shape. Bump when the shape changes in a breaking way. */
export const API_VERSION = 1;
export function toApi(b: BipBundle) {
  return { api_version: API_VERSION, bip: b.bip, needs: b.needs, claims: b.claims };
}

// ---- stances (SPEC 2, consensus signaling module) ------------------------------

export const STANCE_LABEL: Record<NonNullable<Claim['stance']>, string> = {
  'concept-ack': 'Concept ACK',
  'approach-ack': 'Approach ACK',
  ack: 'ACK',
  nack: 'NACK',
  conditional: 'Conditional',
  'needs-research': 'Needs research',
};

const minor = (v: string) => v.split('.').slice(0, 2).map(Number);

/**
 * A position may be stale when the spec changed materially after it: a MAJOR
 * or MINOR bump (BIP 352's changelog: MINOR changes an algorithm's inputs or
 * outputs; PATCH is clarifications and test vectors). 0.0.0 means the position
 * predates any versioned spec.
 */
export function isStale(madeAgainst: string | undefined, current: string | undefined): boolean {
  if (!madeAgainst || !current) return false;
  const [a1, a2] = minor(madeAgainst);
  const [c1, c2] = minor(current);
  return a1 < c1 || (a1 === c1 && a2 < c2);
}

export const versionLabel = (v: string | undefined) =>
  !v ? 'version unknown' : v === '0.0.0' ? 'before the spec was versioned' : `spec v${v}`;

const byDateDesc = (a: Claim, b: Claim) => (b.source.date ?? '').localeCompare(a.source.date ?? '');

/** Proposal-scoped stances: each person's latest, with their earlier ones. */
export function positionsOnProposal(claims: Claim[]): { latest: Claim; earlier: Claim[] }[] {
  const byPerson = new Map<string, Claim[]>();
  for (const c of claims.filter((c) => c.kind === 'stance' && c.scope === 'proposal')) {
    const k = c.subject!.name;
    byPerson.set(k, [...(byPerson.get(k) ?? []), c]);
  }
  return [...byPerson.values()]
    .map((cs) => cs.sort(byDateDesc))
    .map(([latest, ...earlier]) => ({ latest, earlier }))
    .sort((a, b) => byDateDesc(a.latest, b.latest));
}

/**
 * Change- or implementation-scoped stances grouped by what they are about:
 * the linked pull request, or (unlinked, e.g. an amendment argued on the
 * list) the discussion thread they came from. Newest activity first.
 */
export function positionsOnChanges(
  claims: Claim[],
  scope: 'change' | 'implementation',
): { key: string; title: string; url: string; linked: boolean; last: string; stances: Claim[] }[] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims.filter((c) => c.kind === 'stance' && c.scope === scope)) {
    const key = c.change?.url ?? `thread:${c.source.title ?? c.source.url}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .map(([key, stances]) => {
      stances.sort((a, b) => (a.source.date ?? '').localeCompare(b.source.date ?? ''));
      const first = stances[0];
      const linked = !!first.change;
      return {
        key,
        linked,
        title: first.change?.title ?? first.source.title ?? 'Discussion',
        url: first.change?.url ?? first.source.url,
        last: stances.at(-1)!.source.date ?? '',
        stances,
      };
    })
    .sort((a, b) => b.last.localeCompare(a.last));
}

// ---- shared BIP frame (page templates spec) --------------------------------

export const LIFECYCLE = ['Idea', 'Draft', 'Complete', 'Deployed'] as const;
export type Step = (typeof LIFECYCLE)[number] | 'Closed';

/**
 * The lifecycle step for an official status. BIP 3 statuses map directly;
 * BIP 2 ones map as BIP 3 says: Proposed to Complete, Final and Active to
 * Deployed, Rejected, Withdrawn, Replaced and Obsolete to Closed.
 */
export function lifecycleStep(status: string): Step {
  const s = status.toLowerCase();
  if (s === 'draft') return 'Draft';
  if (s === 'complete' || s === 'proposed') return 'Complete';
  if (s === 'deployed' || s === 'final' || s === 'active') return 'Deployed';
  if (['closed', 'rejected', 'withdrawn', 'replaced', 'obsolete', 'deferred'].includes(s)) return 'Closed';
  return 'Idea';
}

/**
 * The "short answer": the lowest-scored needs dimension or dimensions, in
 * words, written by code from needs.yaml. A reviewed bipwatch.short_answer
 * replaces it when present.
 */
export function shortAnswer(needs: BipBundle['needs']): string | null {
  if (!needs) return null;
  const scored = NEED_DIMENSIONS.map((d) => [d, needs.dimensions[d].score] as const).filter(
    (x): x is readonly [NeedDimension, number] => x[1] !== null,
  );
  if (!scored.length) return null;
  const low = Math.min(...scored.map(([, s]) => s));
  const lowest = scored.filter(([, s]) => s === low).map(([d]) => DIMENSION_LABEL[d].toLowerCase());
  const list = lowest.length > 1 ? `${lowest.slice(0, -1).join(', ')} and ${lowest.at(-1)}` : lowest[0];
  if (low >= 4) return `Little help is needed anywhere: every assessed dimension scores 4 or more.`;
  return `What it needs most is ${list}, ${lowest.length > 1 ? 'each scoring' : 'scoring'} ${low} of 5.`;
}

/** Claims by source type, most first, for the rail's evidence bar. */
export function sourceMix(claims: Claim[]): { type: Claim['source']['type']; label: string; n: number }[] {
  const counts = new Map<Claim['source']['type'], number>();
  for (const c of claims) counts.set(c.source.type, (counts.get(c.source.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => ({ type, label: SOURCE_LABEL[type], n })).sort((a, b) => b.n - a.n);
}

/** "18 months", "almost 6 months", "3 weeks": a rough age for people, not for sorting. */
export function roughAge(from: string, to = new Date()): string {
  const days = Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 86_400_000));
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = days / 30.44;
  if (months < 23.5) {
    const m = Math.round(months);
    return `${months < m ? 'almost ' : ''}${m} months`;
  }
  const years = Math.round(months / 12);
  return `${months / 12 < years ? 'almost ' : ''}${years} years`;
}
