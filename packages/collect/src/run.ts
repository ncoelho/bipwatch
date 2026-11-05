import { createHash } from 'node:crypto';
import type pg from 'pg';
import { detectMentions, type MentionContext } from './mentions.ts';
import type { Collector, DocumentInput, RawItem, RawItemInput } from './types.ts';

export interface RunResult {
  source: string;
  ok: boolean;
  items_seen: number;
  items_new: number;
  cursor_before: string | null;
  cursor_after: string | null;
  error?: string;
}

/** Items stored per transaction. Each batch is a handful of round trips. */
export const BATCH_SIZE = 200;

export function contentHash(source: string, item: RawItemInput): string {
  return createHash('sha256')
    .update(`${source}\0${item.external_id}\0${item.body}`)
    .digest('hex');
}

/** Cursor of the last successful run, or null on first run. */
export async function lastCursor(db: pg.Pool, source: string): Promise<string | null> {
  const { rows } = await db.query<{ cursor_after: string | null }>(
    `SELECT cursor_after FROM source_runs
      WHERE source = $1 AND ok ORDER BY finished_at DESC LIMIT 1`,
    [source],
  );
  return rows[0]?.cursor_after ?? null;
}

/**
 * Runs one collector from its stored cursor. Items are stored in batches,
 * each batch (raw items, documents, mentions) in one transaction, and are
 * deduplicated by content_hash. A run that fails is recorded as failed and
 * does not advance the cursor (SPEC 6.1); batches it already committed stay,
 * and the next run skips them by hash.
 */
export async function runCollector(
  db: pg.Pool,
  collector: Collector,
  ctx: MentionContext,
  opts: { batchSize?: number } = {},
): Promise<RunResult> {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const cursorBefore = await lastCursor(db, collector.source);
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO source_runs (source, cursor_before) VALUES ($1, $2) RETURNING id',
    [collector.source, cursorBefore],
  );
  const runId = rows[0].id;
  const result: RunResult = {
    source: collector.source,
    ok: false,
    items_seen: 0,
    items_new: 0,
    cursor_before: cursorBefore,
    cursor_after: cursorBefore,
  };

  let batch: RawItemInput[] = [];
  let batchCursor: string | null = cursorBefore;
  const flush = async () => {
    if (!batch.length) return;
    result.items_new += await storeBatch(db, collector, batch, ctx);
    result.cursor_after = batchCursor;
    batch = [];
  };

  try {
    for await (const { item, cursor } of collector.fetch(cursorBefore)) {
      result.items_seen++;
      batch.push(item);
      batchCursor = cursor;
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }

  await db.query(
    `UPDATE source_runs SET finished_at = now(), ok = $2, items_new = $3, items_seen = $4,
            error = $5, cursor_after = $6 WHERE id = $1`,
    [
      runId,
      result.ok,
      result.items_new,
      result.items_seen,
      result.error ?? null,
      result.ok ? result.cursor_after : cursorBefore,
    ],
  );
  if (!result.ok) result.cursor_after = cursorBefore;
  return result;
}

/** VALUES ($1,$2,...),(...) for `rows` rows of `cols` columns. */
function placeholders(rows: number, cols: number, casts: string[] = []): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(`$${r * cols + c + 1}${casts[c] ?? ''}`);
    out.push(`(${cells.join(', ')})`);
  }
  return out.join(', ');
}

/** Postgres allows 65535 parameters per statement. */
function chunks<T>(xs: T[], cols: number): T[][] {
  const size = Math.max(1, Math.floor(60000 / cols));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Stores a batch of raw items with their documents and mentions in one
 * transaction. Items already archived (same content_hash) are skipped.
 * Returns how many raw items were new.
 */
async function storeBatch(
  db: pg.Pool,
  collector: Collector,
  items: RawItemInput[],
  ctx: MentionContext,
): Promise<number> {
  // Same hash twice in one batch: keep the first.
  const byHash = new Map<string, RawItemInput>();
  for (const item of items) {
    const h = contentHash(collector.source, item);
    if (!byHash.has(h)) byHash.set(h, item);
  }
  const hashed = [...byHash.entries()];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const inserted: RawItem[] = [];
    for (const part of chunks(hashed, 7)) {
      const { rows } = await client.query<{ id: number; content_hash: string; fetched_at: Date }>(
        `INSERT INTO raw_items (source, external_id, url, content_hash, content_type, body, meta)
         VALUES ${placeholders(part.length, 7, ['', '', '', '', '', '', '::jsonb'])}
         ON CONFLICT (content_hash) DO NOTHING
         RETURNING id, content_hash, fetched_at`,
        part.flatMap(([hash, it]) => [
          collector.source,
          it.external_id,
          it.url ?? null,
          hash,
          it.content_type,
          it.body,
          JSON.stringify(it.meta ?? {}),
        ]),
      );
      for (const r of rows) {
        const it = byHash.get(r.content_hash)!;
        inserted.push({
          ...it,
          id: r.id,
          source: collector.source,
          content_hash: r.content_hash,
          fetched_at: r.fetched_at,
          meta: it.meta ?? {},
        });
      }
    }

    // Documents from the new raw items. A later item in the batch wins when
    // two produce the same document (an edit fetched twice).
    const docs = new Map<string, { raw: RawItem; doc: DocumentInput }>();
    for (const raw of inserted.sort((a, b) => a.id - b.id)) {
      for (const doc of collector.normalize(raw)) docs.set(doc.external_id, { raw, doc });
    }
    const docList = [...docs.values()];

    const docIds = new Map<string, number>();
    for (const part of chunks(docList, 9)) {
      const { rows } = await client.query<{ id: number; external_id: string }>(
        `INSERT INTO documents
           (raw_item_id, source, external_id, thread_key, author, posted_at, title, body_text, url)
         VALUES ${placeholders(part.length, 9)}
         ON CONFLICT (source, external_id) DO UPDATE SET
           raw_item_id = EXCLUDED.raw_item_id, thread_key = EXCLUDED.thread_key,
           author = EXCLUDED.author, posted_at = EXCLUDED.posted_at, title = EXCLUDED.title,
           body_text = EXCLUDED.body_text, url = EXCLUDED.url
         RETURNING id, external_id`,
        part.flatMap(({ raw, doc }) => [
          raw.id,
          collector.source,
          doc.external_id,
          doc.thread_key ?? null,
          doc.author ?? null,
          doc.posted_at ?? null,
          doc.title ?? null,
          doc.body_text,
          doc.url ?? null,
        ]),
      );
      for (const r of rows) docIds.set(r.external_id, r.id);
    }

    if (docIds.size) {
      await client.query('DELETE FROM bip_mentions WHERE document_id = ANY($1::bigint[])', [
        [...docIds.values()],
      ]);
      const mentions = docList.flatMap(({ doc }) =>
        detectMentions({ title: doc.title, body: doc.body_text, thread_title: doc.thread_title }, ctx).map(
          (m) => [docIds.get(doc.external_id)!, m.bip, m.method, m.snippet],
        ),
      );
      for (const part of chunks(mentions, 4)) {
        await client.query(
          `INSERT INTO bip_mentions (document_id, bip, method, snippet)
           VALUES ${placeholders(part.length, 4)}`,
          part.flat(),
        );
      }
    }

    await client.query('COMMIT');
    return inserted.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
