import pg from 'pg';

/**
 * Connection pool from DATABASE_URL. Neon connection strings carry
 * sslmode=require, which pg honours.
 */
export function connect(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Put the Neon connection string in .env or export it before running.',
    );
  }
  return new pg.Pool({ connectionString: url, max: 4 });
}

export type Db = pg.Pool | pg.PoolClient;
