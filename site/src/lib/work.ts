// "What needs doing" across tracked BIPs (work page spec). Pure functions
// over the loaded bundles: the open work items, their sort orders, ages and
// flags, and every number the page shows. The page template stays thin and
// the island (work-explorer.ts) only filters what is rendered here.
import { NEED_DIMENSIONS, WORK_AREAS, type BipBundle, type Claim, type WorkArea } from '@bipwatch/data';
import { triager, type Tier } from './triage.ts';
import { AREA_LABEL, SOURCE_LABEL, WORK_KIND_LABEL, WORK_KINDS, bipHref, isPending, isStale, versionLabel } from './view.ts';

export type Area = WorkArea | '';
export type Sort = 'new' | 'old' | 'bip';

export interface WorkItem {
  id: string;
  bip: number;
  bipTitle: string;
  bipStatus: string;
  bipVersion?: string;
  kind: 'task' | 'open-question' | 'objection';
  kindLabel: string;
  area: Area;
  areaLabel: string;
  /** part_of, or '' for the BIP itself. */
  piece: string;
  /** `${bip}|${part_of ?? ''}`: a piece is per BIP. */
  pieceKey: string;
  statement: string;
  who: string;
  date?: string;
  venue: string;
  venueTitle?: string;
  url: string;
  quote?: string;
  quoteMatched: boolean;
  status: string;
  stale: boolean;
  staleLabel?: string;
  old: boolean;
  pending: boolean;
  bipHref: string;
  /** Priority group and why (lib/triage.ts). */
  tier: Tier;
  reasons: string[];
}

/** Hints for the type-of-work tiles. */
export const AREA_HINT: Record<WorkArea | 'none', string> = {
  design: 'Settle open design questions',
  writing: 'Write and tighten spec text',
  engineering: 'Build and port implementations',
  research: 'Measure, prove, compare',
  review: 'Read specs and code critically',
  ux: 'Make it usable in wallets',
  testing: 'Vectors, interop, signet',
  coordination: 'Get the right people talking',
  activation: 'Deployment and miner readiness',
  none: 'No type of work recorded',
};

/** Short column labels for the grid. */
export const AREA_SHORT: Record<WorkArea | 'none', string> = {
  design: 'Design',
  writing: 'Writing',
  engineering: 'Eng.',
  research: 'Research',
  review: 'Review',
  ux: 'UX',
  testing: 'Testing',
  coordination: 'Coord.',
  activation: 'Activ.',
  none: 'Unsorted',
};

export const areaLabel = (a: Area) => (a ? AREA_LABEL[a] : 'Not sorted yet');
export const pieceName = (piece: string, bip: number) => piece || `BIP ${bip} itself`;
export const pieceKey = (bip: number, piece: string) => `${bip}|${piece}`;

const DAY = 86_400_000;
const OLD_DAYS = 730;
const days = (date: string, today: Date) => Math.floor((today.getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY);

/** Older than 2 years at the build date. Undated items (from the spec text) never are. */
export const isOld = (date: string | undefined, today: Date) => !!date && days(date, today) > OLD_DAYS;

/** "5d", "6 wk", "14 mo", "2.4 yr"; undated items come from the spec. */
export function age(date: string | undefined, today: Date): string {
  if (!date) return 'in the spec';
  const d = Math.max(0, days(date, today));
  if (d < 14) return `${d}d`;
  if (d < 63) return `${Math.floor(d / 7)} wk`;
  if (d < OLD_DAYS) return `${Math.floor(d / 30.44)} mo`;
  return `${(d / 365.25).toFixed(1)} yr`;
}

/** Open work on tracked BIPs: tasks, open questions and objections not addressed. */
export function workItems(bundles: BipBundle[], canonical: (name: string) => string, today: Date): WorkItem[] {
  const out: WorkItem[] = [];
  for (const b of bundles) {
    if (!b.bip.bipwatch.tracked) continue;
    const triage = triager(b, today);
    for (const c of b.claims) {
      if (!WORK_KINDS.includes(c.kind) || c.status === 'addressed') continue;
      out.push({ ...toItem(c, b, canonical, today), ...triage(c) });
    }
  }
  return sortItems(out, 'new');
}

function toItem(c: Claim, b: BipBundle, canonical: (name: string) => string, today: Date): Omit<WorkItem, 'tier' | 'reasons'> {
  const area: Area = c.area ?? '';
  const piece = c.part_of ?? '';
  const stale = isStale(c.applies_to_version, b.bip.version);
  return {
    id: c.id,
    bip: b.bip.number,
    bipTitle: b.bip.title,
    bipStatus: b.bip.status,
    ...(b.bip.version ? { bipVersion: b.bip.version } : {}),
    kind: c.kind as WorkItem['kind'],
    kindLabel: WORK_KIND_LABEL[c.kind],
    area,
    areaLabel: areaLabel(area),
    piece,
    pieceKey: pieceKey(b.bip.number, piece),
    statement: c.statement,
    who: c.subject?.name ? canonical(c.subject.name) : 'the authors',
    ...(c.source.date ? { date: c.source.date } : {}),
    venue: SOURCE_LABEL[c.source.type],
    ...(c.source.title ? { venueTitle: c.source.title } : {}),
    url: c.source.url,
    ...(c.source.quote ? { quote: c.source.quote } : {}),
    quoteMatched: c.source.verified === true,
    status: c.status ?? 'unknown',
    stale,
    ...(stale ? { staleLabel: versionLabel(c.applies_to_version) } : {}),
    old: isOld(c.source.date, today),
    pending: isPending(c),
    bipHref: `${bipHref(b.bip.number)}#needs?item=${c.id}`,
  };
}

/** Newest or oldest first (undated last either way), or by BIP, piece, then newest. */
export function sortItems(items: WorkItem[], order: Sort): WorkItem[] {
  const byDate = (dir: 1 | -1) => (a: WorkItem, b: WorkItem) =>
    !a.date && !b.date ? 0 : !a.date ? 1 : !b.date ? -1 : dir * a.date.localeCompare(b.date);
  const sorted = [...items];
  if (order === 'new') return sorted.sort((a, b) => byDate(-1)(a, b) || a.id.localeCompare(b.id));
  if (order === 'old') return sorted.sort((a, b) => byDate(1)(a, b) || a.id.localeCompare(b.id));
  return sorted.sort((a, b) => a.bip - b.bip || a.piece.localeCompare(b.piece) || byDate(-1)(a, b) || a.id.localeCompare(b.id));
}

/** Areas in WORK_AREAS order that have open work, plus '' last when any item has none. */
export function usedAreas(items: WorkItem[]): Area[] {
  const used: Area[] = WORK_AREAS.filter((a) => items.some((i) => i.area === a));
  return items.some((i) => i.area === '') ? [...used, ''] : used;
}

export interface WorkStats {
  open: number;
  tasks: number;
  questions: number;
  objections: number;
  tracked: number;
  withOpen: number;
  /** Tracked BIPs with nothing open. */
  nothingOpen: number[];
  recent: number;
  newest?: string;
  old: number;
  /** [bip, count] of items over 2 years old, largest first. */
  oldByBip: [number, number][];
  addressed: number;
  pending: boolean;
}

export function workStats(items: WorkItem[], bundles: BipBundle[], today: Date): WorkStats {
  const tracked = bundles.filter((b) => b.bip.bipwatch.tracked);
  const withOpen = new Set(items.map((i) => i.bip));
  const oldBy = new Map<number, number>();
  for (const i of items.filter((i) => i.old)) oldBy.set(i.bip, (oldBy.get(i.bip) ?? 0) + 1);
  const dated = items.filter((i) => i.date).map((i) => i.date!).sort();
  return {
    open: items.length,
    tasks: items.filter((i) => i.kind === 'task').length,
    questions: items.filter((i) => i.kind === 'open-question').length,
    objections: items.filter((i) => i.kind === 'objection').length,
    tracked: tracked.length,
    withOpen: withOpen.size,
    nothingOpen: tracked.map((b) => b.bip.number).filter((n) => !withOpen.has(n)).sort((a, b) => a - b),
    recent: items.filter((i) => i.date && days(i.date, today) <= 30).length,
    ...(dated.length ? { newest: dated.at(-1) } : {}),
    old: items.filter((i) => i.old).length,
    oldByBip: [...oldBy].sort((a, b) => b[1] - a[1] || a[0] - b[0]),
    addressed: tracked.reduce((n, b) => n + b.claims.filter((c) => WORK_KINDS.includes(c.kind) && c.status === 'addressed').length, 0),
    pending: items.some((i) => i.pending),
  };
}

export interface GridRow {
  bip: number;
  title: string;
  open: number;
  cells: { area: Area; n: number }[];
  /** Six needs scores in NEED_DIMENSIONS order; null when not scored or no needs.yaml. */
  needs: (number | null)[];
}

/** Every tracked BIP by open count, with open items per used area. */
export function gridRows(items: WorkItem[], bundles: BipBundle[], areas: Area[]): GridRow[] {
  return bundles
    .filter((b) => b.bip.bipwatch.tracked)
    .map((b) => {
      const mine = items.filter((i) => i.bip === b.bip.number);
      return {
        bip: b.bip.number,
        title: b.bip.title,
        open: mine.length,
        cells: areas.map((area) => ({ area, n: mine.filter((i) => i.area === area).length })),
        needs: NEED_DIMENSIONS.map((d) => b.needs?.dimensions[d].score ?? null),
      };
    })
    .sort((a, b) => b.open - a.open || a.bip - b.bip);
}

/** The four-step blue scale: 1, 2–4, 5–14, 15 and up; 0 is empty. */
export const shade = (n: number) => (n <= 0 ? 's0' : n === 1 ? 's1' : n <= 4 ? 's2' : n <= 14 ? 's3' : 's4');

export interface Piece { key: string; bip: number; piece: string; open: number; topAreas: [Area, number][] }

/** Pieces by open count across all BIPs, with their two biggest areas. */
export function topPieces(items: WorkItem[], limit = 10): Piece[] {
  const by = new Map<string, WorkItem[]>();
  for (const i of items) by.set(i.pieceKey, [...(by.get(i.pieceKey) ?? []), i]);
  return [...by.values()]
    .map((list) => {
      const areas = new Map<Area, number>();
      for (const i of list) areas.set(i.area, (areas.get(i.area) ?? 0) + 1);
      return {
        key: list[0].pieceKey,
        bip: list[0].bip,
        piece: list[0].piece,
        open: list.length,
        topAreas: [...areas].sort((a, b) => b[1] - a[1]).slice(0, 2),
      };
    })
    .sort((a, b) => b.open - a.open || a.bip - b.bip || a.piece.localeCompare(b.piece))
    .slice(0, limit);
}

/** "Where help is needed" lead, computed. */
export function mapLead(items: WorkItem[], rows: GridRow[], areas: Area[]): string {
  if (!items.length) return 'Nothing is open on the tracked BIPs.';
  const top = rows[0];
  const pct = Math.round((top.open / items.length) * 100);
  const counts = areas.map((a) => [a, items.filter((i) => i.area === a).length] as const).filter(([, n]) => n > 0);
  const biggest = [...counts].sort((a, b) => b[1] - a[1])[0];
  const smallest = [...counts].sort((a, b) => a[1] - b[1]).slice(0, 2);
  const parts = [`BIP ${top.bip} holds ${pct}% of the open work.`, `${areaLabel(biggest[0])} is the biggest need (${biggest[1]} items).`];
  if (smallest.length === 2 && smallest[0][0] !== biggest[0]) {
    const [a, b] = smallest;
    const n = a[1] === b[1] ? `${a[1]} each` : `${a[1]} and ${b[1]}`;
    parts.push(`${areaLabel(a[0])} and ${areaLabel(b[0]).toLowerCase()} have the fewest open items recorded (${n}).`);
  }
  return parts.join(' ');
}

/** "Biggest open pieces" lead, computed. */
export function piecesLead(items: WorkItem[]): string {
  const own = items.filter((i) => i.piece === '').length;
  return `Only ${own} of ${items.length} open items are about a BIP's own text. The rest belong to companion BIPs and projects: indexes, libraries, proxies, wallet integrations.`;
}
