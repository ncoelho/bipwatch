// Runs migrations and the collector runner against a real Postgres (Neon).
// Skipped unless DATABASE_URL_UNPOOLED or DATABASE_URL is set. Everything
// happens in a throwaway schema that is dropped afterwards.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strictSsl } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import type { MentionContext } from '../src/mentions.ts';
import { runCollector } from '../src/run.ts';
import type { Collector, RawItem } from '../src/types.ts';

const rawUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const url = rawUrl && strictSsl(rawUrl);
const schema = `bipwatch_test_${process.pid}_${Date.now()}`;
const ctx: MentionContext = { aliases: new Map([['silent payments', 352]]) };

const POSTS = [
  { id: 'p1', topic: 't1', title: 'BIP 352 scanning cost', body: 'Opening post about scanning.' },
  { id: 'p2', topic: 't1', title: 'BIP 352 scanning cost', body: 'Reply: silent payments light clients.' },
];

function fixtureCollector(posts = POSTS, failAfter?: number): Collector {
  return {
    source: 'delving',
    async *fetch(cursor) {
      const start = cursor ? Number(cursor) : 0;
      for (let i = start; i < posts.length; i++) {
        if (failAfter !== undefined && i >= failAfter) throw new Error('upstream went away');
        yield {
          item: {
            external_id: posts[i].id,
            url: `https://example.test/${posts[i].id}`,
            content_type: 'application/json',
            body: JSON.stringify(posts[i]),
          },
          cursor: String(i + 1),
        };
      }
    },
    normalize(raw: RawItem) {
      const p = JSON.parse(raw.body);
      return [
        {
          external_id: p.id,
          thread_key: p.topic,
          thread_title: p.title,
          // Like Discourse: only the opening post carries the topic title.
          title: p.id === 'p1' ? p.title : undefined,
          body_text: p.body,
          url: raw.url,
        },
      ];
    },
  };
}

describe.skipIf(!url)('Postgres integration (Neon)', () => {
  let pool: pg.Pool;
  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('applies migrations once', async () => {
    expect(await migrate(pool)).toEqual(['001_init.sql']);
    expect(await migrate(pool)).toEqual([]);
  });

  it('stores items, documents and mentions', async () => {
    const r = await runCollector(pool, fixtureCollector(), ctx);
    expect(r).toMatchObject({ ok: true, items_seen: 2, items_new: 2, cursor_after: '2' });
    expect(await count('raw_items')).toBe(2);
    expect(await count('documents')).toBe(2);
    const { rows } = await pool.query(
      `SELECT d.external_id, m.bip, m.method FROM bip_mentions m
         JOIN documents d ON d.id = m.document_id ORDER BY 1, 3`,
    );
    expect(rows).toEqual([
      { external_id: 'p1', bip: 352, method: 'number' },
      { external_id: 'p2', bip: 352, method: 'alias' },
      { external_id: 'p2', bip: 352, method: 'thread-title' },
    ]);
    const search = await pool.query(
      `SELECT external_id FROM documents WHERE search @@ plainto_tsquery('english', 'light clients')`,
    );
    expect(search.rows).toEqual([{ external_id: 'p2' }]);
  });

  it('adds nothing on a second run, even from the start', async () => {
    const before = [await count('raw_items'), await count('documents'), await count('bip_mentions')];
    const r = await runCollector(pool, fixtureCollector(), ctx);
    expect(r).toMatchObject({ ok: true, items_seen: 0, items_new: 0 });
    await pool.query(`UPDATE source_runs SET cursor_after = NULL`);
    const replay = await runCollector(pool, fixtureCollector(), ctx);
    expect(replay).toMatchObject({ ok: true, items_seen: 2, items_new: 0 });
    expect([await count('raw_items'), await count('documents'), await count('bip_mentions')]).toEqual(before);
  });

  it('records a failed run and keeps the cursor', async () => {
    await pool.query(`UPDATE source_runs SET cursor_after = '2'`);
    const more = [...POSTS, { id: 'p3', topic: 't2', title: 'other', body: 'x' }];
    const r = await runCollector(pool, fixtureCollector(more, 2), ctx);
    expect(r.ok).toBe(false);
    expect(r.cursor_after).toBe('2');
    const last = await pool.query(
      `SELECT ok, error, cursor_after FROM source_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(last.rows[0].ok).toBe(false);
    expect(last.rows[0].error).toContain('upstream went away');
    expect(last.rows[0].cursor_after).toBe('2');
  });
});
