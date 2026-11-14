import {
  NEED_AREAS,
  NEED_DIMENSIONS,
  type BipBundle,
  type Claim,
  type NeedDimension,
  type NeedsAssessment,
} from '@bipwatch/data';
import { stringify } from 'yaml';
import { z } from 'zod';

/**
 * Needs assessment (SPEC "What it needs"): a score per dimension that
 * summarises the BIP's sourced claims, above all its open work. The model
 * reads a digest of the claims (one line each, with its id), never the
 * discussions; every score cites the claim ids it rests on, and code checks
 * they exist. The page links each dimension to its open items through
 * NEED_AREAS, so the assessment only has to say where the BIP stands.
 */

export const NEEDS_VERSION = 1;
export const NEEDS_MODEL = 'claude-opus-5-5';

const LABEL: Record<NeedDimension, string> = {
  problem_evidence: 'Problem evidence: outside evidence that the problem it solves is real and felt today.',
  technical_maturity: 'Technical maturity: how settled and checked the design and spec are (open design questions, spec gaps, test vectors, review, security analysis).',
  ux_exploration: 'UX exploration: how well it is understood how users and wallets meet it (flows, formats, naming).',
  implementations: 'Implementations: who has built it, how completely, and what is still being built.',
  ecosystem_awareness: 'Ecosystem awareness: whether merchants, exchanges, services and users know about it and want it.',
  coordination: 'Coordination: agreement across projects that it depends on (companion specs, shared services, activation).',
};

export const NEEDS_SYSTEM = `You assess what a Bitcoin Improvement Proposal still needs, for BipWatch, a public site that shows people what work would move each BIP forward. You get the BIP's facts and a digest of every sourced claim BipWatch holds about it: each line starts with the claim's id in brackets. Open work (tasks, open questions, objections) carries its type of work, the piece it belongs to (the BIP itself, a companion BIP, or a project built for it) and whether it is open or already addressed.

Score each dimension from 0 to 5, where 5 means no help is needed there and 0 means nothing exists yet. Judge against what the BIP needs to move on from its current status (a Draft needs design settled; a Complete BIP needs implementations, adoption and, for a soft fork, activation). Use null when the claims say nothing either way; do not guess.

Dimensions, and the types of open work that bear on each:
${NEED_DIMENSIONS.map((d) => `- ${d}: ${LABEL[d]}${NEED_AREAS[d].length ? ` Open work of type: ${NEED_AREAS[d].join(', ')}.` : ''}`).join('\n')}

For each dimension:
- score: 0 to 5, or null.
- rationale: two short plain sentences (under 400 characters) saying where it stands and what is missing, specific to this BIP. Name the pieces where the open work is, such as "the light-client index", when that is where it sits. Say only what the claims show. Write for a visitor of the BIP's page: do not mention the digest, claim ids, BipWatch or how the assessment was made; when there is no evidence, say what is not known ("Nothing recorded yet shows…").
- evidence: the ids of the claims the score rests on, copied exactly from the digest, at most 8, the most telling first. Empty only when the score is null.

Weigh open items by what they ask, not by how many there are: one unresolved security objection outweighs many small tasks. Addressed items count as progress. Work on a companion or a project built for the BIP counts toward this BIP's needs only as far as the BIP depends on it to be used.`;

const Dim = z.object({ score: z.number().int().min(0).max(5).nullable(), rationale: z.string(), evidence: z.array(z.string()) });
export const NeedsOutput = z.object({
  problem_evidence: Dim,
  technical_maturity: Dim,
  ux_exploration: Dim,
  implementations: Dim,
  ecosystem_awareness: Dim,
  coordination: Dim,
});
export type NeedsOutput = z.infer<typeof NeedsOutput>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ').trim();

/** One line per claim, grouped by kind, for the model to read. */
export function needsDigest(bundle: BipBundle): string {
  const { bip, claims } = bundle;
  const of = (...kinds: Claim['kind'][]) => claims.filter((c) => kinds.includes(c.kind));
  const lines: string[] = [
    `BIP ${bip.number}: ${bip.title}`,
    `Layer: ${bip.layer ?? 'none'} · Status: ${bip.status}${bip.version ? ` · Version ${bip.version}` : ''}`,
    ...(bip.bipwatch.summary ? [`Summary: ${bip.bipwatch.summary}`] : []),
    ...(bip.related?.length ? [`Companion BIPs: ${bip.related.join(', ')}`] : []),
  ];
  const section = (title: string, items: string[]) => {
    lines.push('', `## ${title} (${items.length})`, ...(items.length ? items : ['(none)']));
  };
  section('Problem, evidence and trade-off claims', of('problem', 'evidence', 'tradeoff', 'adoption').map((c) => `[${c.id}] ${c.kind}: ${clip(c.statement, 240)}`));
  section(
    'Implementations',
    of('implementation').map((c) => {
      const i = c.implementation!;
      const caps = [i.send && 'send', i.receive && 'receive'].filter(Boolean).join('+');
      return `[${c.id}] ${c.subject?.name}: ${i.state}${caps ? ` (${caps})` : ''}${i.scanning ? `, scanning: ${clip(i.scanning, 80)}` : ''}`;
    }),
  );
  const work = of('task', 'open-question', 'objection');
  const workLine = (c: Claim) =>
    `[${c.id}] ${c.status ?? 'unknown'} ${c.kind} · ${c.area ?? 'no type'} · ${c.part_of ?? `BIP ${bip.number} itself`}: ${clip(c.statement, 220)}`;
  section('Open work, still open', work.filter((c) => c.status !== 'addressed').map(workLine));
  section('Open work, already addressed', work.filter((c) => c.status === 'addressed').map(workLine));
  const stances = of('stance');
  const tally = new Map<string, number>();
  for (const c of stances.filter((s) => s.scope === 'proposal')) tally.set(c.stance!, (tally.get(c.stance!) ?? 0) + 1);
  section(
    'Positions on the proposal',
    stances
      .filter((c) => c.scope === 'proposal' && ['nack', 'conditional', 'needs-research'].includes(c.stance!))
      .map((c) => `[${c.id}] ${c.subject?.name} ${c.stance}: ${clip(c.condition ?? c.statement, 200)}`),
  );
  lines.push(`Proposal positions in total: ${[...tally].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}.`);
  return lines.join('\n');
}

/** Problems with the model's output: unknown ids, scores without evidence, long rationales. */
export function checkNeeds(out: NeedsOutput, ids: Set<string>): string[] {
  const errors: string[] = [];
  for (const d of NEED_DIMENSIONS) {
    const x = out[d];
    for (const id of x.evidence) if (!ids.has(id)) errors.push(`${d}: unknown claim id "${id}"; copy ids exactly from the digest`);
    if (x.score !== null && !x.evidence.length) errors.push(`${d}: a score needs evidence, or use null`);
    if (x.rationale.trim().length < 10 || x.rationale.length > 400) errors.push(`${d}: rationale must be 10 to 400 characters`);
  }
  return errors;
}

export function toAssessment(out: NeedsOutput, bip: number, today: string, model: string): NeedsAssessment {
  return {
    bip,
    assessed: today,
    provenance: { extracted_by: `model:${model}`, extracted: today, reviewed_by: null },
    dimensions: Object.fromEntries(
      NEED_DIMENSIONS.map((d) => [d, { score: out[d].score, rationale: out[d].rationale.trim(), evidence: [...new Set(out[d].evidence)].slice(0, 8) }]),
    ) as NeedsAssessment['dimensions'],
  };
}

export function needsYaml(a: NeedsAssessment): string {
  return [
    '# Needs assessment generated by `npm run needs` from the claims in this folder;',
    '# pending review. Scores are 0-5, where 5 means no help needed.',
    stringify(a, { lineWidth: 80 }),
  ].join('\n');
}
