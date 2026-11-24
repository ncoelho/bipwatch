/**
 * npm run recheck -- [--bip <n>]... [--spec] [--budget <tokens>] [--max-threads <n>] [--dry-run] [--summary <file>]
 *
 * Triage step 4: closes open work that later messages or the current spec
 * show settled (see recheck.ts). Thread batches carry no spec text, which
 * keeps the weekly run cheap; the spec goes only with --spec batches. For each tracked BIP, the threads of its
 * open items that have messages archived since the last recheck run, one
 * model call per thread; with --spec, also items raised on an older spec
 * version, against the current text. An item is written as addressed only
 * with a verbatim quote that code finds in the message or spec; it keeps its
 * provenance (reviewed_by stays as it was) and gains `resolution`. Runs are
 * recorded in extract_runs (task "recheck"), whose cursor is the newest
 * archived document at the start of the run; a run stopped by the budget
 * keeps the old cursor, so nothing is skipped.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bipsRepoDir, connect, showFile, updateBipsRepo } from '@bipwatch/collect';
import { canonicalName, findDataDir, folderFor, loadAll, loadPeople, noBacklink, noMentions, type Claim } from '@bipwatch/data';
import { parse } from 'yaml';
import { claudeClient } from './model.ts';
import {
  checkRecheck, closeClaim, olderSpec, RECHECK_MODEL, RECHECK_VERSION, recheckable, recheckMessage, RecheckOutput, recheckSystem,
  resolved, specBatches, type Batch, type Resolved,
} from './recheck.ts';
import { claimYaml, finishRun, lastCursor, startRun } from './store.ts';
import { billedTokens, type Usage } from './types.ts';

const { values } = parseArgs({
  options: {
    bip: { type: 'string', multiple: true, default: [] },
    spec: { type: 'boolean', default: false },
    budget: { type: 'string', default: '400000' },
    'max-threads': { type: 'string', default: '80' },
    'dry-run': { type: 'boolean', default: false },
    summary: { type: 'string' },
  },
});
const dataDir = findDataDir();
const only = new Set(values.bip!.map(Number));
const bundles = loadAll(dataDir).filter((b) => b.bip.bipwatch.tracked && (!only.size || only.has(b.bip.number)));
const budget = Number(values.budget);
const maxThreads = Number(values['max-threads']);
const dryRun = values['dry-run'];
const today = new Date().toISOString().slice(0, 10);
const canonical = canonicalName(loadPeople());

const model = claudeClient();
const db = connect();
const bipsDir = bipsRepoDir();
await updateBipsRepo(bipsDir);
const { rows: top } = await db.query<{ max: string | null }>('SELECT max(id) AS max FROM documents');
const newest = Number(top[0].max ?? 0);

let usage: Usage = { input_tokens: 0, output_tokens: 0 };
const add = (u: Usage) => {
  usage = {
    input_tokens: usage.input_tokens + u.input_tokens,
    output_tokens: usage.output_tokens + u.output_tokens,
    cache_read_tokens: (usage.cache_read_tokens ?? 0) + (u.cache_read_tokens ?? 0),
    cache_write_tokens: (usage.cache_write_tokens ?? 0) + (u.cache_write_tokens ?? 0),
  };
};
const closed: { bip: number; r: Resolved }[] = [];
let failed = false;

for (const b of bundles) {
  const items = b.claims.filter(recheckable);
  if (!items.length) continue;
  const cursor = await lastCursor(db, 'recheck', RECHECK_VERSION, b.bip.number);
  const runId = await startRun(db, { task: 'recheck', version: RECHECK_VERSION, model: RECHECK_MODEL, dryRun, cursor, bip: b.bip.number });
  let threads = 0;
  let written = 0;
  let stopped: 'done' | 'budget' = 'done';
  try {
    const specText = (await showFile(bipsDir, b.bip.spec.revision, b.bip.spec.path)) ?? undefined;
    // Thread batches leave the spec out; only spec batches need it.
    const systems = { thread: recheckSystem(b.bip, specText, false), spec: recheckSystem(b.bip, specText, true) };

    // Threads of open items with messages archived since the last run.
    const { rows: docs } = await db.query<{ url: string; source: string; thread_key: string }>(
      'SELECT DISTINCT ON (url) url, source, thread_key FROM documents WHERE url = ANY($1::text[]) AND thread_key IS NOT NULL ORDER BY url, id',
      [[...new Set(items.map((c) => c.source.url))]],
    );
    const threadOf = new Map(docs.map((d) => [d.url, `${d.source}\0${d.thread_key}`]));
    const byThread = new Map<string, Claim[]>();
    for (const c of items) {
      const t = threadOf.get(c.source.url);
      if (t) byThread.set(t, [...(byThread.get(t) ?? []), c]);
    }
    const batches: Batch[] = [];
    for (const [key, list] of byThread) {
      const [source, thread] = key.split('\0');
      const since = list.map((c) => c.source.date ?? '').sort()[0] || '1970-01-01';
      const { rows } = await db.query<{ url: string; author: string | null; posted_at: Date | null; body_text: string }>(
        `SELECT url, author, posted_at, body_text FROM documents
          WHERE source = $1 AND thread_key = $2 AND posted_at > $3::date AND id > $4 AND id <= $5
            AND url IS NOT NULL AND length(trim(body_text)) > 0
          ORDER BY posted_at LIMIT 12`,
        [source, thread, since, cursor, newest],
      );
      if (!rows.length) continue;
      batches.push({
        bip: b.bip.number,
        thread: key,
        items: list,
        messages: rows.map((r) => ({
          url: r.url,
          author: canonical(r.author ?? 'unknown'),
          ...(r.posted_at ? { date: r.posted_at.toISOString().slice(0, 10) } : {}),
          text: r.body_text,
        })),
      });
    }
    batches.splice(maxThreads);
    if (values.spec) batches.push(...specBatches(b.bip, items.filter((c) => !batches.some((x) => x.items.includes(c))), (v) => olderSpec(v, b.bip.version)));

    for (const batch of batches) {
      if (billedTokens(usage) > budget) {
        stopped = 'budget';
        break;
      }
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: recheckMessage(batch) }];
      let out: RecheckOutput | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await model.run({ model: RECHECK_MODEL, effort: 'medium', system: batch.thread === 'spec' ? systems.spec : systems.thread, messages, schema: RecheckOutput });
        add(res.usage);
        if (!res.output) throw new Error(`BIP ${b.bip.number}: model returned ${res.stop}`);
        out = res.output;
        const errors = checkRecheck(out, batch, specText);
        if (!errors.length) break;
        console.log(`  BIP ${b.bip.number} ${batch.thread === 'spec' ? 'spec' : 'thread'} attempt ${attempt}: ${errors.join('; ')}`);
        messages.push({ role: 'assistant', content: res.text });
        messages.push({ role: 'user', content: `Fix these problems and answer for every item again:\n${errors.map((e) => `- ${e}`).join('\n')}` });
      }
      threads++;
      // Whatever still fails its own check stays open.
      for (const r of resolved(out!, batch, b.bip, specText, RECHECK_MODEL, today)) {
        closed.push({ bip: b.bip.number, r });
        written++;
        if (!dryRun) {
          const file = join(dataDir, 'bips', folderFor(b.bip.number), 'claims', `${r.claim.id}.yaml`);
          // Re-read the file so nothing written since loading is lost.
          const current = parse(readFileSync(file, 'utf8')) as Claim;
          writeFileSync(file, claimYaml(closeClaim({ ...r, claim: current })));
        }
      }
    }
    console.log(`BIP ${b.bip.number}: ${items.length} open items, ${batches.length} batches, ${threads} checked, ${written} now addressed${stopped === 'budget' ? ' · stopped by the budget' : ''}`);
    await finishRun(db, runId, {
      docs_seen: threads,
      claims_written: written,
      usage,
      stopped_by: stopped,
      // A run cut short keeps the old cursor so its threads are checked next time.
      last_document_id: stopped === 'budget' || dryRun ? cursor : newest,
    }, cursor);
  } catch (err) {
    failed = true;
    console.error(`BIP ${b.bip.number}: ${(err as Error).message}`);
    await finishRun(db, runId, null, cursor, (err as Error).message);
  }
}
await db.end();

if (values.summary && closed.length) {
  const lines = [
    `Rechecked open work against later messages${values.spec ? ' and the current spec text' : ''} (\`npm run recheck\`). ${closed.length} ${closed.length === 1 ? 'item is' : 'items are'} now addressed, each with the quote that shows it. Check each quote really settles the item; to keep one open, revert its file.`,
    '',
  ];
  for (const n of [...new Set(closed.map((c) => c.bip))]) {
    lines.push(`### BIP ${n}`, '');
    for (const { r } of closed.filter((c) => c.bip === n)) {
      lines.push(`- **${noMentions(r.claim.statement.replace(/\s+/g, ' '))}**`);
      lines.push(`  > ${noMentions(r.resolution.quote)}`);
      lines.push(`  ${noBacklink(r.resolution.url)}${r.resolution.date ? ` (${r.resolution.date})` : ''}`);
    }
    lines.push('');
  }
  lines.push(`${billedTokens(usage)} billed-equivalent tokens.`, '', '🤖 Opened by the recheck workflow');
  // GitHub caps a pull request body at 65,536 characters.
  writeFileSync(resolve(values.summary), lines.join('\n').slice(0, 60_000));
}
console.log(`Done: ${closed.length} items now addressed · ${billedTokens(usage)} billed-equivalent tokens${dryRun ? ' · dry run' : ''}`);
if (failed) process.exit(1);
