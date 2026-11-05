import pg from 'pg';

const MISSING =
  'is not set. Run `neon env pull` (writes .env.local), put the Neon connection string in .env, or export it.';

/**
 * Connection pool for the collectors. Uses DATABASE_URL, Neon's pooled
 * (PgBouncer) endpoint. The collectors are long-running Node jobs, so this is
 * node-postgres over TCP, not the serverless driver. Neon URLs carry
 * sslmode=require, which pg honours.
 */
export function connect(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error(`DATABASE_URL ${MISSING}`);
  return new pg.Pool({ connectionString: strictSsl(url), max: 4 });
}

/**
 * Neon URLs say sslmode=require. pg 8 already treats that as verify-full
 * (certificate and hostname checked) but warns that pg 9 will weaken it, so
 * spell out verify-full to keep the strict behaviour.
 */
export function strictSsl(url: string): string {
  return url.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
}

/**
 * Direct (unpooled) connection for migrations: DDL and multi-statement
 * scripts should not go through the transaction-mode pooler. Falls back to
 * DATABASE_URL where only one URL is configured (e.g. CI secrets).
 */
export function connectDirect(): pg.Pool {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL_UNPOOLED or DATABASE_URL ${MISSING}`);
  return new pg.Pool({ connectionString: strictSsl(url), max: 1 });
}

export type Db = pg.Pool | pg.PoolClient;
