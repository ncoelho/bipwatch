import type { Claim } from '@bipwatch/data';

/**
 * Pull request description for claims an extraction run wrote (SPEC 6.2:
 * "the bot opens one PR per BIP per run with each claim's source link in the
 * PR description"). One table row per claim: stance and scope, who, the
 * statement and quote, the source, the change it is about, and its file.
 */

export interface RunInfo {
  bip: number;
  runId: number;
  docs: number;
  inputTokens: number;
  outputTokens: number;
}

const STANCE_ORDER = ['nack', 'conditional', 'needs-research', 'concept-ack', 'approach-ack', 'ack'];
const SCOPE_ORDER = ['proposal', 'change', 'implementation'];

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function prSummary(opts: {
  claims: Claim[];
  runs: RunInfo[];
  task: { id: string; version: number; model: string };
}): string {
  const { claims, runs, task } = opts;
  const sorted = [...claims].sort(
    (a, b) =>
      SCOPE_ORDER.indexOf(a.scope ?? '') - SCOPE_ORDER.indexOf(b.scope ?? '') ||
      STANCE_ORDER.indexOf(a.stance ?? '') - STANCE_ORDER.indexOf(b.stance ?? '') ||
      (a.source.date ?? '').localeCompare(b.source.date ?? ''),
  );
  const docs = runs.reduce((n, r) => n + r.docs, 0);
  const tokensIn = runs.reduce((n, r) => n + r.inputTokens, 0);
  const tokensOut = runs.reduce((n, r) => n + r.outputTokens, 0);
  const proposal = claims.filter((c) => c.scope === 'proposal').length;

  return [
    `${claims.length} ${claims.length === 1 ? 'claim' : 'claims'} proposed by the \`${task.id}\` extractor (v${task.version}, \`model:${task.model}\`) from ${docs} newly archived ${docs === 1 ? 'document' : 'documents'}. **All have \`reviewed_by: null\`.** Merging adds them to the record as pending; edit or delete any file here first if it is wrong.`,
    '',
    proposal
      ? `**${proposal} ${proposal === 1 ? 'is a position' : 'are positions'} on the proposal itself**: check ${proposal === 1 ? 'it' : 'those'} first; the BIP page shows them under "On the proposal".`
      : 'None is a position on the proposal itself: all are reviews of a change or an implementation.',
    '',
    'Checked by code before writing: the quote matches the archived document; the subject is the document\'s author (mapped through `people.yaml`); the spec version is the one in force on that date.',
    '',
    '| Stance | Who | Statement and quote | Source | Claim file |',
    '|---|---|---|---|---|',
    ...sorted.map((c) => {
      const src = `[${c.source.type} ${c.source.date ?? ''}](${c.source.url})${c.change ? ` · [PR](${c.change.url})` : ''}`;
      return `| \`${c.stance}\` (${c.scope}) | ${cell(c.subject?.name ?? '')} | ${cell(cut(c.statement, 200))}<br>“${cell(cut(c.source.quote ?? '', 140))}” | ${src} | \`data/bips/${String(c.bip).padStart(4, '0')}/claims/${c.id}.yaml\` |`;
    }),
    '',
    `Extraction ${runs.map((r) => `run ${r.runId} (BIP ${r.bip})`).join(', ')}: ${tokensIn.toLocaleString('en')} input + ${tokensOut.toLocaleString('en')} output tokens. Per-document outcomes and rejected proposals are in \`extract_log\`.`,
    '',
    '🤖 Opened by the extraction workflow',
  ].join('\n');
}
