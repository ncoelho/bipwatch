import { parseArgs } from 'node:util';
import { bipsRepoDir, connect, updateBipsRepo } from '@bipwatch/collect';
import { findDataDir, loadAll } from '@bipwatch/data';
import { claudeClient } from './model.ts';
import { runTask } from './run.ts';
import { finishRun, lastCursor, logDoc, selectDocs, startRun, writeClaim } from './store.ts';
import { TASKS } from './tasks/index.ts';
import type { BipContext } from './types.ts';
import { makeValidator } from './validate.ts';
import { specVersionTimeline, versionAt } from './version.ts';

const USAGE = `Usage: npm run extract -- --task <id> [--bip <n>] [--limit <docs>] [--budget <tokens>] [--dry-run [--source <id>]]

  --task     ${Object.keys(TASKS).join(', ')}
  --bip      only documents mentioning this tracked BIP (default: every tracked BIP)
  --limit    at most this many documents (default 50)
  --budget   stop starting documents after this many tokens, input + output (default 200000)
  --dry-run  call the model and validate, but write no files and keep the cursor;
             prints each proposed claim and each rejection in full
  --source   with --dry-run only: sample one source (bips-repo, github, delving, mailing-list);
             may be repeated
  --doc      with --dry-run only: run on these document ids (repeat, or comma-separated),
             e.g. to compare a new prompt version on documents an older one handled

Each run starts after the last document a previous (non-dry) run processed.
Claims are written to data/bips/<NNNN>/claims/ with reviewed_by: null.`;

const { values } = parseArgs({
  options: {
    task: { type: 'string' },
    bip: { type: 'string' },
    limit: { type: 'string', default: '50' },
    budget: { type: 'string', default: '200000' },
    'dry-run': { type: 'boolean', default: false },
    source: { type: 'string', multiple: true },
    doc: { type: 'string', multiple: true },
    help: { type: 'boolean', default: false },
  },
});

const task = values.task ? TASKS[values.task] : undefined;
if (values.help || !task) {
  console.error(values.task ? `Unknown task "${values.task}".\n\n${USAGE}` : USAGE);
  process.exit(values.help ? 0 : 2);
}

const dataDir = findDataDir(process.env.INIT_CWD);
const bundles = loadAll(dataDir);
const tracked = bundles.filter((b) => b.bip.bipwatch.tracked).map((b) => b.bip);
const wanted = values.bip ? tracked.filter((b) => b.number === Number(values.bip)) : tracked;
if (!wanted.length) {
  console.error(values.bip ? `BIP ${values.bip} is not tracked.` : 'No tracked BIPs.');
  process.exit(2);
}
const dryRun = values['dry-run'];
const ids = (values.doc ?? []).flatMap((d) => d.split(',')).map(Number).filter(Number.isInteger);
if ((values.source?.length || ids.length) && !dryRun) {
  // A filtered real run would move the cursor past other documents.
  console.error('--source and --doc only work with --dry-run.');
  process.exit(2);
}
const limit = Number(values.limit);
const budget = Number(values.budget);

// Fail before touching the database when there are no Claude API credentials
// (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile).
let model: ReturnType<typeof claudeClient>;
let pool: ReturnType<typeof connect>;
try {
  model = claudeClient();
  pool = connect();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// Spec version timelines come from the bitcoin/bips clone used by the collector.
const bipsDir = bipsRepoDir();
await updateBipsRepo(bipsDir);
const bips = new Map<number, BipContext>();
for (const bip of wanted) {
  const timeline = await specVersionTimeline(bipsDir, bip);
  bips.set(bip.number, { bip, versionAt: (d) => versionAt(timeline, d) });
}

const today = new Date().toISOString().slice(0, 10);
const validator = makeValidator(bundles.flatMap((b) => b.claims), dataDir);
let failed = false;

// One run per BIP, each from that BIP's own cursor, so a newly tracked BIP
// starts from the beginning of the archive. --limit and --budget apply to
// each BIP's run.
for (const ctx of bips.values()) {
  const bip = ctx.bip.number;
  const cursor = await lastCursor(pool, task.id, task.version, bip);
  const runId = await startRun(pool, { task: task.id, version: task.version, model: task.model, dryRun, cursor, bip });
  console.log(
    `${task.id} v${task.version} · ${task.model} · BIP ${bip} · after document ${cursor} · limit ${limit} · budget ${budget} tokens${dryRun ? ' · dry run' : ''}`,
  );
  try {
    const summary = await runTask({
      task,
      docs: selectDocs(pool, {
        bips: [bip],
        // A document list is a fixed sample: ignore the cursor.
        afterId: ids.length ? 0 : cursor,
        limit: ids.length ? ids.length : limit,
        sources: values.source,
        ids,
      }),
      model,
      bips: new Map([[bip, ctx]]),
      validator,
      today,
      budgetTokens: budget,
      onDoc: async (r) => {
        await logDoc(pool, runId, r);
        for (const c of r.claims) {
          const where = dryRun ? '(dry run)' : writeClaim(dataDir, c).replace(`${dataDir}/`, 'data/');
          console.log(`+ ${c.kind} ${c.stance ?? ''}${c.scope ? ` (${c.scope})` : ''} BIP ${c.bip} · ${c.subject?.name} · ${where}`);
          if (dryRun) {
            console.log(`    statement: ${c.statement}`);
            if (c.condition) console.log(`    condition: ${c.condition}`);
            console.log(`    quote:     ${JSON.stringify(c.source.quote)}`);
            console.log(`    source:    ${c.source.url} (${c.source.date ?? 'no date'}, spec ${c.applies_to_version})`);
            if (c.change) console.log(`    change:    ${c.change.url}${c.change.title ? ` (${c.change.title})` : ''}`);
          }
        }
        if (dryRun) {
          for (const rej of r.rejected) {
            console.log(`- rejected (attempt ${rej.attempt}) document ${r.document_id}: ${rej.errors.join('; ')}`);
            if (rej.claim?.source?.quote) console.log(`    quote:     ${JSON.stringify(rej.claim.source.quote)}`);
          }
        }
        if (r.outcome !== 'claims' && r.outcome !== 'none') {
          console.log(`  document ${r.document_id}: ${r.outcome}${r.rejected.length ? ` (${r.rejected.at(-1)!.errors.join('; ')})` : ''}`);
        }
      },
    });
    await finishRun(pool, runId, dryRun ? { ...summary, last_document_id: cursor } : summary, cursor);
    console.log(
      `Done (${summary.stopped_by}): ${summary.docs_seen} documents · ${summary.claims_written} claims · ${summary.usage.input_tokens} input + ${summary.usage.output_tokens} output tokens · run ${runId}`,
    );
  } catch (err) {
    await finishRun(pool, runId, null, cursor, (err as Error).stack ?? String(err));
    console.error((err as Error).message);
    failed = true;
    break;
  }
}
await pool.end();
process.exitCode = failed ? 1 : 0;
