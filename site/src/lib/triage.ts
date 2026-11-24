// Priority groups for open work (step 1 of the triage plan): code-only, from
// fields every claim already has. Each item gets one tier and the reasons
// that put it there, shown next to it, so a reader can disagree with a
// reason instead of a hidden score.
//
// Two questions decide the tier:
//   holds back — does it bear on what the BIP lacks right now? Its type of
//     work sits behind a weak needs score, it is cited as the reason for a
//     needs score that is not yet good, or it is an objection or open
//     question while the BIP is still a draft.
//   fresh — was it raised in the last 90 days?
//
// First match wins:
//   outdated   over 2 years old, or raised against an older version of the
//              BIP's own text: check it still applies before working on it
//   attention  holds back and fresh
//   important  holds back
//   later      everything else
//
// Nobody has reviewed the items yet (they are machine-extracted), so the
// pages say these groups are computed.
import { NEED_AREAS, NEED_DIMENSIONS, type BipBundle, type Claim, type NeedDimension } from '@bipwatch/data';
import { DIMENSION_LABEL, isStale, versionLabel } from './view.ts';

export type Tier = 'attention' | 'important' | 'later' | 'outdated';
export const TIERS: Tier[] = ['attention', 'important', 'later', 'outdated'];
export const TIER_LABEL: Record<Tier, string> = {
  attention: 'Needs attention',
  important: 'Important',
  later: 'Can wait',
  outdated: 'May be outdated',
};
export const TIER_HINT: Record<Tier, string> = {
  attention: 'Holds the BIP back and was raised in the last 90 days',
  important: 'Holds the BIP back, but has been quiet',
  later: 'Real work, not on what the BIP lacks right now',
  outdated: 'Over 2 years old or about an older spec version; check it still applies',
};

/** Scores at or below this hold a BIP back. */
export const WEAK_SCORE = 2;
/** Needs scores below this still count when an item is cited as their reason. */
const NOT_YET_GOOD = 4;
export const FRESH_DAYS = 90;
export const OLD_DAYS = 730;

export interface Triage { tier: Tier; reasons: string[] }

const DAY = 86_400_000;
const daysAgo = (date: string, today: Date) => Math.floor((today.getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY);
const ago = (d: number) => (d < 14 ? `${d} days ago` : d < 63 ? `${Math.floor(d / 7)} weeks ago` : d < 730 ? `${Math.floor(d / 30.44)} months ago` : `${(d / 365.25).toFixed(1)} years ago`);

/**
 * The dimensions holding a BIP back: those with open types of work and a
 * score of WEAK_SCORE or less; when there are none, the lowest-scored ones
 * below NOT_YET_GOOD.
 */
export function weakDimensions(b: BipBundle): NeedDimension[] {
  if (!b.needs) return [];
  const scored = NEED_DIMENSIONS.filter((d) => NEED_AREAS[d].length > 0 && b.needs!.dimensions[d].score !== null);
  const weak = scored.filter((d) => b.needs!.dimensions[d].score! <= WEAK_SCORE);
  if (weak.length) return weak;
  const low = Math.min(...scored.map((d) => b.needs!.dimensions[d].score!));
  return low < NOT_YET_GOOD ? scored.filter((d) => b.needs!.dimensions[d].score === low) : [];
}

/** A triage function for one BIP; precomputes what every item shares. */
export function triager(b: BipBundle, today: Date): (c: Claim) => Triage {
  const weak = weakDimensions(b);
  const score = (d: NeedDimension) => `${DIMENSION_LABEL[d]} (${b.needs!.dimensions[d].score}/5)`;
  const cites = new Map<string, NeedDimension>();
  if (b.needs)
    for (const d of NEED_DIMENSIONS) {
      const s = b.needs.dimensions[d].score;
      if (s !== null && s < NOT_YET_GOOD) for (const id of b.needs.dimensions[d].evidence) if (!cites.has(id)) cites.set(id, d);
    }
  const draft = b.bip.status === 'Draft';

  return (c) => {
    const age = c.source.date ? daysAgo(c.source.date, today) : null;
    if (age !== null && age > OLD_DAYS) return { tier: 'outdated', reasons: [`Raised ${ago(age)}`] };
    // Only the BIP's own text has versions; companion pieces have their own.
    if (!c.part_of && isStale(c.applies_to_version, b.bip.version))
      return { tier: 'outdated', reasons: [`Raised on ${versionLabel(c.applies_to_version)}; the spec is now v${b.bip.version}`] };

    const holds: string[] = [];
    const dim = c.area ? weak.find((d) => NEED_AREAS[d].includes(c.area!)) : undefined;
    if (dim) holds.push(`Holds back ${score(dim)}`);
    const cited = cites.get(c.id);
    if (cited && cited !== dim) holds.push(`Behind the ${score(cited)} score`);
    if (draft && c.kind === 'objection') holds.push('Objection to a draft');
    if (draft && c.kind === 'open-question') holds.push('Open question on a draft');

    const fresh = age !== null && age <= FRESH_DAYS;
    const when = age === null ? [] : [`Raised ${ago(age)}`];
    if (holds.length && fresh) return { tier: 'attention', reasons: [...holds, ...when] };
    if (holds.length) return { tier: 'important', reasons: [...holds, ...when] };
    return { tier: 'later', reasons: age === null ? ['From the spec text'] : when };
  };
}
