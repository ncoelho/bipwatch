import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderFor, type Claim } from '@bipwatch/data';
import type pg from 'pg';
import { stringify } from 'yaml';
import type { DocResult, RunSummary } from './run.ts';
import type { InputDoc } from './types.ts';

/**
 * Documents linked to a tracked BIP, after the cursor, in id order. Joining
 * raw_items is the SPEC 6.2 check that the document exists in the archive.
 * Documents without an author are skipped: a stance needs someone to hold it.
 */
export async function* selectDocs(
  db: pg.Pool,
  opts: { bips: number[]; afterId: number; limit: number; pageSize?: number; sources?: string[]; ids?: number[] },
): AsyncGenerator<InputDoc> {
  let after = opts.afterId;
  let left = opts.limit;
  const page = opts.pageSize ?? 100;
  while (left > 0) {
    const { rows } = await db.query<InputDoc & { posted_at: Date | null }>(
      `SELECT d.id::int AS id, d.source, d.external_id, d.thread_key, d.title, d.author, d.posted_at, d.body_text, d.url,
              (SELECT t.title FROM documents t
                WHERE t.source = d.source AND t.thread_key = d.thread_key AND t.title IS NOT NULL
                ORDER BY t.posted_at NULLS LAST, t.id LIMIT 1) AS thread_title,
              array_agg(DISTINCT m.bip ORDER BY m.bip) AS bips,
              -- Up to 8 later messages in the thread, as context for status.
              (SELECT left(string_agg(coalesce(l.author, '?') || ' (' || coalesce(l.posted_at::date::text, '?') || '): '
                                      || left(regexp_replace(l.body_text, '\s+', ' ', 'g'), 700), E'\n\n' ORDER BY l.posted_at), 6000)
                 FROM (SELECT * FROM documents l2
                        WHERE l2.source = d.source AND l2.thread_key = d.thread_key AND l2.id <> d.id
                          AND l2.posted_at > d.posted_at
                        ORDER BY l2.posted_at LIMIT 8) l) AS later
         FROM documents d
         JOIN raw_items r ON r.id = d.raw_item_id
         JOIN bip_mentions m ON m.document_id = d.id AND m.bip = ANY($1::int[])
        WHERE d.id > $2 AND ($4::text[] IS NULL OR d.source = ANY($4::text[]))
          AND ($5::bigint[] IS NULL OR d.id = ANY($5::bigint[])) AND d.author IS NOT NULL AND d.url IS NOT NULL AND length(trim(d.body_text)) > 0
        GROUP BY d.id
        ORDER BY d.id
        LIMIT $3`,
      [opts.bips, after, Math.min(page, left), opts.sources?.length ? opts.sources : null, opts.ids?.length ? opts.ids : null],
    );
    if (!rows.length) return;
    for (const r of rows) yield r;
    after = rows[rows.length - 1].id;
    left -= rows.length;
  }
}

/**
 * Where the next run of a task for one BIP starts: the last ok, non-dry run's
 * cursor for this task version and BIP. A new version (new prompt or schema)
 * or a newly tracked BIP starts from the beginning of the archive.
 */
export async function lastCursor(db: pg.Pool, task: string, version: number, bip: number): Promise<number> {
  const { rows } = await db.query<{ cursor_after: string | null }>(
    `SELECT cursor_after FROM extract_runs
      WHERE task = $1 AND task_version = $2 AND bip = $3 AND ok AND NOT dry_run
      ORDER BY finished_at DESC LIMIT 1`,
    [task, version, bip],
  );
  return Number(rows[0]?.cursor_after ?? 0);
}

export async function startRun(
  db: pg.Pool,
  r: { task: string; version: number; model: string; dryRun: boolean; cursor: number; bip: number },
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO extract_runs (task, task_version, model, dry_run, cursor_before, bip)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [r.task, r.version, r.model, r.dryRun, r.cursor, r.bip],
  );
  return Number(rows[0].id);
}

export async function logDoc(db: pg.Pool, runId: number, r: DocResult): Promise<void> {
  await db.query(
    `INSERT INTO extract_log (run_id, document_id, outcome, attempts, claim_ids, rejected, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      runId,
      r.document_id,
      r.outcome,
      r.attempts,
      r.claims.map((c) => c.id),
      JSON.stringify(r.rejected),
      r.usage.input_tokens,
      r.usage.output_tokens,
    ],
  );
}

export async function finishRun(
  db: pg.Pool,
  runId: number,
  s: RunSummary | null,
  cursorBefore: number,
  error?: string,
): Promise<void> {
  await db.query(
    `UPDATE extract_runs SET finished_at = now(), ok = $2, cursor_after = $3, docs_seen = $4,
            claims_written = $5, input_tokens = $6, output_tokens = $7, stopped_by = $8, error = $9
      WHERE id = $1`,
    [
      runId,
      !error,
      error ? cursorBefore : (s?.last_document_id ?? cursorBefore),
      s?.docs_seen ?? 0,
      s?.claims_written ?? 0,
      s?.usage.input_tokens ?? 0,
      s?.usage.output_tokens ?? 0,
      error ? 'error' : (s?.stopped_by ?? 'done'),
      error ?? null,
    ],
  );
}

/** Field order for claim files, so diffs stay readable. */
const ORDER: (keyof Claim)[] = [
  'id', 'bip', 'kind', 'status', 'area', 'stance', 'condition', 'scope', 'change', 'statement', 'subject',
  'implementation', 'applies_to_version', 'source', 'provenance', 'tags',
];

export function claimYaml(c: Claim): string {
  const missing = Object.keys(c).filter((k) => !ORDER.includes(k as keyof Claim));
  // A field added to the schema but not here would be dropped silently.
  if (missing.length) throw new Error(`claimYaml: no position for ${missing.join(', ')}`);
  const ordered = Object.fromEntries(
    ORDER.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]),
  );
  return stringify(ordered, { lineWidth: 80 });
}

/** Writes one file per claim: data/bips/<NNNN>/claims/<id>.yaml. */
export function writeClaim(dataDir: string, c: Claim): string {
  const dir = join(dataDir, 'bips', folderFor(c.bip), 'claims');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${c.id}.yaml`);
  writeFileSync(file, claimYaml(c), { flag: 'wx' });
  return file;
}
