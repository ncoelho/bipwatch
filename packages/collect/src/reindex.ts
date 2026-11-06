import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { ALL_SOURCES, COLLECTORS } from './collectors/index.ts';
import { connect } from './db.ts';
import { buildMentionContext, detectMentions, type MentionContext } from './mentions.ts';
import type { Collector, RawItem, SourceId } from './types.ts';

/**
 * Recomputes bip_mentions for archived documents. Mentions are normally
 * tagged once, when a document is stored, using the aliases of the BIPs
 * tracked at that moment. When a BIP becomes tracked (or its aliases
 * change), run this so every document already in the archive is tagged with
 * the current rules, so a newly tracked BIP gets its whole history.
 *
 * Each document is re-derived by its collector's own normalize() from the
 * raw item it came from, so thread titles and bodies are exactly what the
 * collector produced; only the mention rules are new. Nothing is fetched.
 */

export interface ReindexResult {
  source: SourceId;
  documents: number;
  mentions_before: number;
  mentions_after: number;
  /** Documents whose collector no longer produces them from their raw item. */
  unmatched: number;
  /** Per-BIP change in tagged documents, only where it changed. */
  changed: { bip: number; before: number; after: number }[];
}

/** Fingerprint of the mention rules: the alias set, order-independent. */
export function contextFingerprint(ctx: MentionContext): string {
  const aliases = [...ctx.aliases].sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(aliases)).digest('hex');
}

export async function storedFingerprint(db: pg.Pool): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(`SELECT value FROM index_state WHERE key = 'mention_context'`);
  return rows[0]?.value ?? null;
}

export async function saveFingerprint(db: pg.Pool, fp: string): Promise<void> {
  await db.query(
    `INSERT INTO index_state (key, value) VALUES ('mention_context', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [fp],
  );
}

async function perBip(db: pg.Pool, source: string): Promise<Map<number, number>> {
  const { rows } = await db.query<{ bip: number; n: string }>(
    `SELECT m.bip, count(DISTINCT m.document_id) AS n
       FROM bip_mentions m JOIN documents d ON d.id = m.document_id
      WHERE d.source = $1 GROUP BY m.bip`,
    [source],
  );
  return new Map(rows.map((r) => [r.bip, Number(r.n)]));
}

async function mentionCount(db: pg.Pool, source: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM bip_mentions m JOIN documents d ON d.id = m.document_id WHERE d.source = $1`,
    [source],
  );
  return Number(rows[0].n);
}

export async function reindexSource(
  db: pg.Pool,
  collector: Collector,
  ctx: MentionContext,
  batch = 500,
): Promise<ReindexResult> {
  const source = collector.source;
  const before = await perBip(db, source);
  const result: ReindexResult = {
    source,
    documents: 0,
    mentions_before: await mentionCount(db, source),
    mentions_after: 0,
    unmatched: 0,
    changed: [],
  };

  let after = 0;
  for (;;) {
    // Only the raw item each document currently points at (its latest version).
    const { rows: raws } = await db.query<RawItem & { id: string }>(
      `SELECT r.id, r.source, r.external_id, r.url, r.content_hash, r.fetched_at, r.content_type, r.body, r.meta
         FROM raw_items r
        WHERE r.source = $1 AND r.id > $2
          AND EXISTS (SELECT 1 FROM documents d WHERE d.raw_item_id = r.id)
        ORDER BY r.id LIMIT $3`,
      [source, after, batch],
    );
    if (!raws.length) break;
    after = Number(raws[raws.length - 1].id);

    const byRaw = new Map<number, Map<string, ReturnType<Collector['normalize']>[number]>>();
    for (const r of raws) {
      const raw: RawItem = { ...r, id: Number(r.id) };
      byRaw.set(raw.id, new Map(collector.normalize(raw).map((d) => [d.external_id, d])));
    }
    const { rows: docs } = await db.query<{ id: string; external_id: string; raw_item_id: string }>(
      `SELECT id, external_id, raw_item_id FROM documents WHERE source = $1 AND raw_item_id = ANY($2::bigint[])`,
      [source, [...byRaw.keys()]],
    );

    const ids: number[] = [];
    const values: unknown[] = [];
    for (const d of docs) {
      const input = byRaw.get(Number(d.raw_item_id))?.get(d.external_id);
      if (!input) {
        result.unmatched++;
        continue;
      }
      ids.push(Number(d.id));
      for (const m of detectMentions(
        { title: input.title, body: input.body_text, thread_title: input.thread_title },
        ctx,
      )) {
        values.push(Number(d.id), m.bip, m.method, m.snippet);
      }
    }
    result.documents += ids.length;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM bip_mentions WHERE document_id = ANY($1::bigint[])', [ids]);
      for (let i = 0; i < values.length; i += 4 * 10_000) {
        const part = values.slice(i, i + 4 * 10_000);
        const rowsSql = Array.from({ length: part.length / 4 }, (_, r) =>
          `($${r * 4 + 1}, $${r * 4 + 2}, $${r * 4 + 3}, $${r * 4 + 4})`,
        ).join(', ');
        await client.query(`INSERT INTO bip_mentions (document_id, bip, method, snippet) VALUES ${rowsSql}`, part);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  result.mentions_after = await mentionCount(db, source);
  const afterBip = await perBip(db, source);
  for (const bip of new Set([...before.keys(), ...afterBip.keys()])) {
    const b = before.get(bip) ?? 0;
    const a = afterBip.get(bip) ?? 0;
    if (a !== b) result.changed.push({ bip, before: b, after: a });
  }
  result.changed.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { source: { type: 'string', multiple: true }, 'if-changed': { type: 'boolean', default: false } },
  });
  const sources = (values.source?.length ? values.source : ALL_SOURCES) as SourceId[];
  for (const s of sources) {
    if (!ALL_SOURCES.includes(s)) {
      console.error(`Unknown source "${s}". Sources: ${ALL_SOURCES.join(', ')}`);
      process.exit(2);
    }
  }
  let pool: pg.Pool;
  try {
    pool = connect();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const ctx = buildMentionContext();
  const fp = contextFingerprint(ctx);
  console.log(`Aliases: ${[...ctx.aliases].map(([a, b]) => `"${a}" → ${b}`).join(', ') || 'none'}`);
  try {
    if (values['if-changed'] && (await storedFingerprint(pool)) === fp) {
      console.log('Mention rules unchanged since the last re-index; nothing to do.');
      await pool.end();
      process.exit(0);
    }
    for (const s of sources) {
      const r = await reindexSource(pool, COLLECTORS[s](), ctx);
      const diff = r.changed.slice(0, 8).map((c) => `BIP ${c.bip} ${c.before}→${c.after}`).join(', ');
      console.log(
        `${s}: ${r.documents} documents · mentions ${r.mentions_before} → ${r.mentions_after}` +
          (r.unmatched ? ` · ${r.unmatched} unmatched` : '') +
          (r.changed.length ? ` · ${r.changed.length} BIPs changed: ${diff}` : ' · no BIP changed'),
      );
    }
    // Only a full re-index (every source) brings the whole archive up to date.
    if (sources.length === ALL_SOURCES.length) await saveFingerprint(pool, fp);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
