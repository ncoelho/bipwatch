/**
 * npm run repin-versions -- [--dry-run]
 *
 * Recomputes applies_to_version for every claim with a source date, from the
 * spec's version timeline (changelog first, else the Version header's git
 * history), and rewrites only that line where it differs. Use after the
 * timeline logic changes, as when BIP 77's "- 0.2.0 2025-07-08" changelog
 * format was not recognised and its claims were pinned to 0.0.0.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bipsRepoDir, updateBipsRepo } from '@bipwatch/collect';
import { findDataDir, folderFor, loadAll } from '@bipwatch/data';
import { specVersionTimeline, versionAt } from './version.ts';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dataDir = findDataDir();
const bipsDir = bipsRepoDir();
await updateBipsRepo(bipsDir);

let changed = 0;
for (const { bip, claims } of loadAll(dataDir).filter((b) => b.claims.length)) {
  const timeline = await specVersionTimeline(bipsDir, bip);
  const moves = new Map<string, number>();
  for (const c of claims) {
    if (!c.source.date || c.applies_to_version === undefined) continue;
    const want = versionAt(timeline, new Date(`${c.source.date}T12:00:00Z`));
    if (want === c.applies_to_version) continue;
    const file = join(dataDir, 'bips', folderFor(bip.number), 'claims', `${c.id}.yaml`);
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/^applies_to_version: .*$/m, `applies_to_version: ${want}`);
    if (next === text) continue;
    if (!values['dry-run']) writeFileSync(file, next);
    const key = `${c.applies_to_version} -> ${want}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
    changed++;
  }
  if (moves.size) console.log(`BIP ${bip.number}: ${[...moves].map(([k, n]) => `${n} × ${k}`).join(', ')}`);
}
console.log(`Done: ${changed} claims ${values['dry-run'] ? 'would change' : 'repinned'}`);
