import { createHash } from 'node:crypto';
import type pg from 'pg';
import { detectMentions, type MentionContext } from './mentions.ts';
import type { Collector, RawItem, RawItemInput } from './types.ts';

export interface RunResult {
  source: string;
  ok: boolean;
  items_seen: number;
  items_new: number;
  cursor_before: string | null;
  cursor_after: string | null;
  error?: string;
}

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
 * Runs one collector from its stored cursor. Every raw item is stored with
 * its documents and mentions in one transaction. If the run fails part way,
 * the items already stored stay (they are deduplicated by content_hash), but
 * the run is recorded as failed and the cursor does not advance.
 */
export async function runCollector(
  db: pg.Pool,
  collector: Collector,
  ctx: MentionContext,
): Promise<RunResult> {
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

  try {
    for await (const { item, cursor } of collector.fetch(cursorBefore)) {
      result.items_seen++;
      if (await storeItem(db, collector, item, ctx)) result.items_new++;
      result.cursor_after = cursor;
    }
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.stack ?? err.message : String(err);
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

/** Stores one raw item. Returns false when it was already archived. */
async function storeItem(
  db: pg.Pool,
  collector: Collector,
  input: RawItemInput,
  ctx: MentionContext,
): Promise<boolean> {
  const hash = contentHash(collector.source, input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: number; fetched_at: Date }>(
      `INSERT INTO raw_items (source, external_id, url, content_hash, content_type, body, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING id, fetched_at`,
      [
        collector.source,
        input.external_id,
        input.url ?? null,
        hash,
        input.content_type,
        input.body,
        input.meta ?? {},
      ],
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const raw: RawItem = {
      ...input,
      id: inserted.rows[0].id,
      source: collector.source,
      content_hash: hash,
      fetched_at: inserted.rows[0].fetched_at,
      meta: input.meta ?? {},
    };

    for (const doc of collector.normalize(raw)) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO documents
           (raw_item_id, source, external_id, thread_key, author, posted_at, title, body_text, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (source, external_id) DO UPDATE SET
           raw_item_id = EXCLUDED.raw_item_id, thread_key = EXCLUDED.thread_key,
           author = EXCLUDED.author, posted_at = EXCLUDED.posted_at, title = EXCLUDED.title,
           body_text = EXCLUDED.body_text, url = EXCLUDED.url
         RETURNING id`,
        [
          raw.id,
          collector.source,
          doc.external_id,
          doc.thread_key ?? null,
          doc.author ?? null,
          doc.posted_at ?? null,
          doc.title ?? null,
          doc.body_text,
          doc.url ?? null,
        ],
      );
      const docId = rows[0].id;
      await client.query('DELETE FROM bip_mentions WHERE document_id = $1', [docId]);
      for (const m of detectMentions(
        { title: doc.title, body: doc.body_text, thread_title: doc.thread_title },
        ctx,
      )) {
        await client.query(
          'INSERT INTO bip_mentions (document_id, bip, method, snippet) VALUES ($1, $2, $3, $4)',
          [docId, m.bip, m.method, m.snippet],
        );
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
