import type { BipBundle, PrStates, SpecHistory } from './types.ts';

/**
 * Contradictions code can see between a BIP's data and the world (page
 * templates spec, "Data-check banner"). Each names the problem and the file
 * to fix. Nothing here judges prose; it compares dates and states.
 */
export interface DataCheck {
  /** One sentence, plain text: what disagrees. */
  text: string;
  /** Short subject shown in bold, e.g. the implementation's name. */
  subject: string;
  /** Repo-relative path of the file to fix. */
  file: string;
  /** What to do, as a link label. */
  fix: string;
}

const pad = (n: number) => String(n).padStart(4, '0');

export function dataChecks(b: BipBundle, history: SpecHistory | null, prs: PrStates | null): DataCheck[] {
  const out: DataCheck[] = [];
  const folder = `data/bips/${pad(b.bip.number)}`;

  // An implementation's state against its pull request.
  for (const c of b.claims.filter((x) => x.kind === 'implementation' && x.subject?.url)) {
    const pr = prs?.prs[c.subject!.url!];
    const state = c.implementation!.state;
    if (!pr) continue;
    const file = `${folder}/claims/${c.id}.yaml`;
    if ((state === 'in-review' || state === 'planned') && pr.state === 'merged')
      out.push({ subject: c.subject!.name, text: `is marked “${state}”, but its pull request merged on ${pr.merged}.`, file, fix: 'Update the claim' });
    else if ((state === 'in-review' || state === 'planned') && pr.state === 'closed')
      out.push({ subject: c.subject!.name, text: `is marked “${state}”, but its pull request was closed without merging.`, file, fix: 'Update the claim' });
    else if (state === 'merged' && pr.state !== 'merged')
      out.push({ subject: c.subject!.name, text: `is marked “merged”, but its pull request is ${pr.state}.`, file, fix: 'Update the claim' });
  }

  // The record against the spec's history.
  const last = history?.changes.at(-1);
  if (last && last.sha !== b.bip.spec.revision && last.date > (b.bip.spec.synced ?? ''))
    out.push({ subject: 'Spec revision', text: `is behind bitcoin/bips: the spec changed on ${last.date} (${last.title}).`, file: `${folder}/bip.yaml`, fix: 'Run the header sync' });

  // The needs assessment against the claims it summarises.
  if (b.needs) {
    const newer = b.claims.filter((c) => c.provenance.extracted > b.needs!.assessed).length;
    if (newer >= 10)
      out.push({ subject: 'What it needs', text: `was assessed on ${b.needs.assessed}; ${newer} claims are newer than that.`, file: `${folder}/needs.yaml`, fix: 'Reassess (npm run needs)' });
  }
  return out;
}
