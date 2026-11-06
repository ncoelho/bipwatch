// File writing always runs; the database part runs against Neon in a
// throwaway schema when DATABASE_URL(_UNPOOLED) is set.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@bipwatch/collect';
import pg from 'pg';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishRun, lastCursor, logDoc, selectDocs, startRun, writeClaim } from '../src/store.ts';
import { stanceTask } from '../src/tasks/stance/index.ts';
import { schemaValidator } from '../src/validate.ts';
import { bips, doc } from './helpers.ts';

const claim = stanceTask.toClaims(
  { stances: [{ bip: 352, stance: 'nack', scope: 'proposal', condition: null, statement: 'Alice Example opposes it.', quote: 'NACK' }] },
  doc(1, 'NACK'),
  { bips, today: '2026-11-06', modelId: 'claude-opus-5-5' },
)[0];

describe('writeClaim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bipwatch-claims-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one schema-valid YAML file per claim and never overwrites', () => {
    const file = writeClaim(dir, claim);
    expect(file).toBe(join(dir, 'bips', '0352', 'claims', `${claim.id}.yaml`));
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe(`id: ${claim.id}`);
    expect(text).toContain('reviewed_by: null');
    expect(schemaValidator()(parse(text))).toEqual([]);
    expect(() => writeClaim(dir, claim)).toThrow(/EEXIST/);
  });
});

const raw = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const url = raw?.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
const schema = `bipwatch_extract_test_${process.pid}_${Date.now()}`;

describe.skipIf(!url)('extract store (Neon)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    await migrate(pool);
    // Four documents: two mention 352, one mentions 341 only, one has no author.
    await pool.query(`INSERT INTO raw_items (source, external_id, content_hash, content_type, body)
      SELECT 'delving', 'r' || g, 'h' || g, 'text/plain', 'x' FROM generate_series(1, 4) g`);
    await pool.query(`INSERT INTO documents (raw_item_id, source, external_id, thread_key, author, title, body_text, url)
      VALUES (1, 'delving', 'p1', 't1', 'alice', 'BIP352 thread', 'Concept ACK', 'https://x.test/1'),
             (2, 'delving', 'p2', 't1', 'bob',   NULL,           'NACK',        'https://x.test/2'),
             (3, 'delving', 'p3', 't2', 'carol', 'Taproot',      'ACK 341',     'https://x.test/3'),
             (4, 'delving', 'p4', 't1', NULL,    NULL,           'anon',        'https://x.test/4')`);
    await pool.query(`INSERT INTO bip_mentions (document_id, bip, method, snippet)
      VALUES (1, 352, 'number', 's'), (2, 352, 'thread-title', 's'), (3, 341, 'number', 's'), (4, 352, 'number', 's')`);
  });
  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const all = async (it: AsyncIterable<unknown>) => {
    const out = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('selects authored documents mentioning tracked BIPs, with their thread title, in pages', async () => {
    const docs = (await all(selectDocs(pool, { bips: [352], afterId: 0, limit: 10, pageSize: 1 }))) as {
      id: number;
      author: string;
      thread_title: string;
      bips: number[];
    }[];
    expect(docs.map((d) => [d.id, d.author, d.thread_title, d.bips])).toEqual([
      [1, 'alice', 'BIP352 thread', [352]],
      [2, 'bob', 'BIP352 thread', [352]],
    ]);
    expect(await all(selectDocs(pool, { bips: [352], afterId: 1, limit: 10 }))).toHaveLength(1);
    expect(await all(selectDocs(pool, { bips: [352], afterId: 0, limit: 1 }))).toHaveLength(1);
  });

  it('tracks runs and resumes after the last ok non-dry run', async () => {
    expect(await lastCursor(pool, 'stance', 1, 352)).toBe(0);
    const dry = await startRun(pool, { task: 'stance', version: 1, model: 'm', dryRun: true, cursor: 0, bip: 352 });
    await finishRun(pool, dry, { docs_seen: 2, claims_written: 1, usage: { input_tokens: 5, output_tokens: 1 }, stopped_by: 'done', last_document_id: 0 }, 0);
    expect(await lastCursor(pool, 'stance', 1, 352)).toBe(0);

    const id = await startRun(pool, { task: 'stance', version: 1, model: 'm', dryRun: false, cursor: 0, bip: 352 });
    await logDoc(pool, id, {
      document_id: 1, outcome: 'claims', attempts: 1, claims: [claim], rejected: [],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    await finishRun(pool, id, { docs_seen: 1, claims_written: 1, usage: { input_tokens: 5, output_tokens: 1 }, stopped_by: 'budget', last_document_id: 1 }, 0);
    expect(await lastCursor(pool, 'stance', 1, 352)).toBe(1);

    const failed = await startRun(pool, { task: 'stance', version: 1, model: 'm', dryRun: false, cursor: 1, bip: 352 });
    await finishRun(pool, failed, null, 1, 'boom');
    expect(await lastCursor(pool, 'stance', 1, 352)).toBe(1);

    // A new task version, or another BIP, starts from the beginning.
    expect(await lastCursor(pool, 'stance', 2, 352)).toBe(0);
    expect(await lastCursor(pool, 'stance', 1, 54)).toBe(0);

    const { rows } = await pool.query(`SELECT outcome, claim_ids FROM extract_log WHERE run_id = $1`, [id]);
    expect(rows).toEqual([{ outcome: 'claims', claim_ids: [claim.id] }]);
  });
});
