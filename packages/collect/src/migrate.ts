import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDirect } from './db.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies every migrations/*.sql not yet recorded, each in its own transaction. */
export async function migrate(pool = connectDirect()): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !done.has(f))
    .sort();

  for (const name of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return pending;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool: ReturnType<typeof connectDirect>;
  try {
    pool = connectDirect();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  migrate(pool)
    .then((applied) => {
      console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date');
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
