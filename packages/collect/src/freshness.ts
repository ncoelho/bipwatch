import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Freshness, SourceFreshness } from '@bipwatch/data';
import type pg from 'pg';
import { connect } from './db.ts';
import type { SourceId } from './types.ts';

/**
 * SPEC 6.1 freshness monitor. A source is stale when it has not succeeded
 * within twice its cadence (the schedules in .github/workflows/*.yml).
 * `npm run freshness` exits 1 when any source is stale; `--export <file>`
 * writes data/freshness.json for the site (no error text, nothing private).
 */

export const SOURCES: { source: SourceId; label: string; cadence_minutes: number }[] = [
  { source: 'bips-repo', label: 'BIP repository', cadence_minutes: 30 },
  { source: 'github', label: 'GitHub', cadence_minutes: 60 },
  { source: 'delving', label: 'Delving Bitcoin', cadence_minutes: 30 },
  { source: 'mailing-list', label: 'bitcoin-dev mailing list', cadence_minutes: 60 },
];

export interface SourceRow {
  source: string;
  last_success: Date | null;
  last_failure: Date | null;
  documents: number;
}

export interface FreshnessReport extends Freshness {
  /** Extra detail for the CLI only; not exported. */
  detail: Record<string, { age_minutes: number | null; last_failure: string | null }>;
}

/** Pure: rows from the database plus the clock to a report. */
export function computeFreshness(rows: SourceRow[], now: Date): FreshnessReport {
  const byId = new Map(rows.map((r) => [r.source, r]));
  const detail: FreshnessReport['detail'] = {};
  const sources: SourceFreshness[] = SOURCES.map(({ source, label, cadence_minutes }) => {
    const r = byId.get(source);
    const last = r?.last_success ?? null;
    const age = last ? (now.getTime() - last.getTime()) / 60000 : null;
    detail[source] = {
      age_minutes: age === null ? null : Math.round(age),
      last_failure: r?.last_failure?.toISOString() ?? null,
    };
    return {
      source,
      label,
      cadence_minutes,
      last_success: last?.toISOString() ?? null,
      stale: age === null || age > 2 * cadence_minutes,
      documents: r?.documents ?? 0,
    };
  });
  return { generated_at: now.toISOString(), sources, detail };
}

export async function readSourceRows(db: pg.Pool): Promise<SourceRow[]> {
  const { rows } = await db.query<{
    source: string;
    last_success: Date | null;
    last_failure: Date | null;
    documents: string;
  }>(`
    SELECT s.source,
           (SELECT max(finished_at) FROM source_runs r WHERE r.source = s.source AND r.ok) AS last_success,
           (SELECT max(finished_at) FROM source_runs r WHERE r.source = s.source AND NOT r.ok) AS last_failure,
           (SELECT count(*) FROM documents d WHERE d.source = s.source) AS documents
      FROM unnest($1::text[]) AS s(source)`,
    [SOURCES.map((s) => s.source)],
  );
  return rows.map((r) => ({ ...r, documents: Number(r.documents) }));
}

/** The exported shape: the report without CLI-only detail. */
export function toExport(report: FreshnessReport): Freshness {
  return { generated_at: report.generated_at, sources: report.sources };
}

export function formatReport(report: FreshnessReport): string {
  const lines = report.sources.map((s) => {
    const d = report.detail[s.source];
    const age = d.age_minutes === null ? 'never' : `${d.age_minutes} min ago`;
    const fail =
      d.last_failure && (!s.last_success || d.last_failure > s.last_success) ? ` · last run failed ${d.last_failure}` : '';
    return `${s.stale ? 'STALE' : 'ok   '}  ${s.source.padEnd(13)} ${age.padEnd(12)} (limit ${2 * s.cadence_minutes} min) · ${s.documents} documents${fail}`;
  });
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { export: { type: 'string' }, 'no-fail': { type: 'boolean' } },
  });
  let pool: pg.Pool;
  try {
    pool = connect();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  try {
    const report = computeFreshness(await readSourceRows(pool), new Date());
    console.log(formatReport(report));
    if (values.export) {
      const file = resolve(process.env.INIT_CWD ?? process.cwd(), values.export);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(toExport(report), null, 2)}\n`);
      console.log(`Wrote ${file}`);
    }
    const stale = report.sources.filter((s) => s.stale).map((s) => s.source);
    if (stale.length && !values['no-fail']) {
      console.error(`Stale: ${stale.join(', ')}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
