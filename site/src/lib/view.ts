// Labels and small helpers shared by pages. All data comes from @bipwatch/data.
import type { BipBundle, Category, Claim, NeedDimension } from '@bipwatch/data';

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
  'in-review': 'In review',
  planned: 'Planned',
  'not-supported': 'Not supported',
  'proof-of-concept': 'Proof of concept',
};

export const STATE_ORDER = ['shipped', 'partial', 'proof-of-concept', 'in-review', 'planned', 'not-supported'];

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

/** Public JSON shape. Bump when the shape changes in a breaking way. */
export const API_VERSION = 1;
export function toApi(b: BipBundle) {
  return { api_version: API_VERSION, bip: b.bip, needs: b.needs, claims: b.claims };
}
