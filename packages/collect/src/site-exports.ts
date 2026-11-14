/**
 * npm run site-exports -- [--optional]
 *
 * Build-time facts for the site, written to data/generated/ (not committed),
 * next to freshness.json. The site never queries Postgres; it reads these.
 *
 * - spec-history/<n>.json for every BIP folder: the spec file's changes on
 *   bitcoin/bips master (from git), each typed "says" (what the BIP says),
 *   "edit" or "process", plus the changelog's dated versions. A change is
 *   typed by its pull request's labels when the archive has them (Proposed
 *   BIP modification → says, Fixups → edit, Process → process...), else
 *   from the diff: header only → process, a changelog entry → says, other
 *   body changes → edit. `flag` marks a "says" change with no changelog
 *   entry.
 * - github-prs.json: state, opened and merged dates of every GitHub pull
 *   request a claim links to (subject.url, change.url, source.url), from the
 *   archive. Needs DATABASE_URL.
 *
 * --optional: a missing bips clone or database skips that export with a
 * note instead of failing (as predev and prebuild run it).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, loadAll } from '@bipwatch/data';
import { changelogEntries } from './bips/changelog.ts';
import { bipsRepoDir, showFile } from './bips/git.ts';
import { specHistory, type SpecChange } from './bips/history.ts';
import { connect } from './db.ts';

export type ChangeType = 'says' | 'edit' | 'process';

const SAYS = ['Proposed BIP modification', 'BIP Update by Owner', 'New BIP', 'Bug fix'];
const EDIT = ['Fixups', 'Typo-to-be-collected', 'Link fix', 'Tests'];
const PROCESS = ['Metadata Update', 'Process', 'CI'];

/** A change's type: from its PR labels when known, else from its diff. */
export function changeType(
  c: SpecChange,
  labels: string[] | undefined,
  first: boolean,
  /** Date of the spec's first changelog version, if it has one. */
  changelogSince?: string,
): { type: ChangeType; by: 'labels' | 'diff'; flag: boolean } {
  // An unlabelled PR says nothing about the change; read the diff instead.
  if (!labels?.length) labels = undefined;
  const has = (set: string[]) => labels?.some((l) => set.includes(l));
  let type: ChangeType;
  let by: 'labels' | 'diff' = 'labels';
  if (first) type = 'says';
  // Labels are coarse: a few changed lines under a "says" label are an edit.
  else if (labels && has(SAYS)) type = c.bodyLines > 4 || c.changelog ? 'says' : 'edit';
  else if (labels && has(EDIT)) type = 'edit';
  else if (labels && has(PROCESS)) type = 'process';
  else {
    by = 'diff';
    type = c.changelog ? 'says' : c.body ? 'edit' : 'process';
  }
  // A missing changelog entry only counts once the spec keeps a changelog.
  const keepsLog = !!changelogSince && c.date >= changelogSince;
  return { type, by, flag: !first && keepsLog && type === 'says' && c.body && !c.changelog };
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

async function main() {
  const { values } = parseArgs({ options: { optional: { type: 'boolean', default: false } } });
  const dataDir = findDataDir();
  const out = join(dataDir, 'generated');
  mkdirSync(join(out, 'spec-history'), { recursive: true });
  const bundles = loadAll(dataDir);

  const db = process.env.DATABASE_URL ? connect() : null;
  if (!db) console.log('site-exports: no DATABASE_URL, so no PR labels or states.');

  // PR records from the archive, newest stored version per PR.
  const prRecords = async (ids: string[]) => {
    if (!db || !ids.length)
      return new Map<string, { state: string; created_at: string; merged_at: string | null; labels: string[]; reviews?: { author: string | null; state: string; submitted_at: string }[] }>();
    const { rows } = await db.query<{ external_id: string; body: string }>(
      `SELECT DISTINCT ON (external_id) external_id, body FROM raw_items
        WHERE source = 'github' AND external_id = ANY($1) ORDER BY external_id, id DESC`,
      [ids],
    );
    return new Map(rows.map((r) => [r.external_id, JSON.parse(r.body)]));
  };

  // Spec history.
  const bipsDir = bipsRepoDir();
  if (!existsSync(join(bipsDir, '.git')) && !existsSync(join(bipsDir, 'HEAD'))) {
    const why = `no bitcoin/bips clone at ${bipsDir}`;
    if (!values.optional) throw new Error(why);
    console.log(`site-exports: ${why}, so no spec history.`);
  } else {
    for (const { bip } of bundles) {
      const text = await showFile(bipsDir, 'origin/master', bip.spec.path);
      if (!text) continue;
      const history = await specHistory(bipsDir, 'origin/master', bip.spec.path, text);
      const prs = await prRecords([...new Set(history.flatMap((c) => (c.pr ? [`bitcoin/bips#${c.pr}`] : [])))]);
      const versions = changelogEntries(text);
      const changes = history.map((c, i) => {
        const labels = c.pr ? prs.get(`bitcoin/bips#${c.pr}`)?.labels : undefined;
        return { ...c, ...changeType(c, labels, i === 0, versions[0]?.date), ...(labels ? { labels } : {}) };
      });
      writeFileSync(
        join(out, 'spec-history', `${bip.number}.json`),
        `${JSON.stringify({ bip: bip.number, path: bip.spec.path, versions, changes }, null, 1)}\n`,
      );
    }
    console.log(`site-exports: spec history for ${bundles.length} BIPs.`);
  }

  // PR states for every pull request a claim links to.
  if (db) {
    const urls = new Set<string>();
    for (const { claims } of bundles)
      for (const c of claims)
        for (const u of [c.subject?.url, c.change?.url, c.source.url]) {
          const m = u?.match(PR_URL);
          if (m) urls.add(`${m[1]}#${m[2]}`);
        }
    const recs = await prRecords([...urls]);
    const prs = Object.fromEntries(
      [...recs].map(([id, r]) => {
        const [repo, n] = id.split('#');
        const reviews = (r.reviews ?? []).map((v: { author: string | null; state: string; submitted_at: string }) => ({ by: v.author, state: v.state.toLowerCase(), date: v.submitted_at.slice(0, 10) }));
        return [`https://github.com/${repo}/pull/${n}`, { state: r.state.toLowerCase(), opened: r.created_at.slice(0, 10), merged: r.merged_at?.slice(0, 10) ?? null, reviews }];
      }),
    );
    writeFileSync(join(out, 'github-prs.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), prs }, null, 1)}\n`);
    console.log(`site-exports: ${recs.size} of ${urls.size} linked pull requests are in the archive.`);
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((e) => {
    console.error(`site-exports: ${(e as Error).message}`);
    process.exit(1);
  });
}
