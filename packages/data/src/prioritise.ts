/**
 * npm run prioritise -- <claim-id> <attention|important|later|outdated|clear> --by <handle> [--note "why"]
 *
 * Sets (or clears) a person's priority group on one open work item: the
 * `priority` field, which overrides the group the site computes. On an item
 * in a topic it sets the whole topic. Only a person runs this; extractors
 * never write the field. Commit the change through a pull request.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { findDataDir, listBipFolders } from './index.ts';
import { PRIORITY_TIERS, type Claim, type PriorityTier } from './types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { by: { type: 'string' }, note: { type: 'string' } },
});
const [id, choice] = positionals;
const usage = 'npm run prioritise -- <claim-id> <attention|important|later|outdated|clear> --by <handle> [--note "why"]';
if (!id || !choice) throw new Error(usage);
if (choice !== 'clear' && !PRIORITY_TIERS.includes(choice as PriorityTier)) throw new Error(`Unknown group "${choice}". ${usage}`);
if (choice !== 'clear' && !/^[A-Za-z0-9._-]+$/.test(values.by ?? '')) throw new Error(`--by needs your handle. ${usage}`);

const dataDir = findDataDir();
const file = listBipFolders(dataDir).map((f) => join(dataDir, 'bips', f, 'claims', `${id}.yaml`)).find(existsSync);
if (!file) throw new Error(`No claim "${id}" under ${join(dataDir, 'bips')}`);
const claim = parse(readFileSync(file, 'utf8')) as Claim;
if (!['task', 'open-question', 'objection'].includes(claim.kind)) throw new Error(`${id} is a ${claim.kind}; priority is for open work only`);

// Keep the writer's field order: priority goes right after status.
const out: Record<string, unknown> = {};
for (const [k, v] of Object.entries(claim)) {
  if (k === 'priority') continue;
  out[k] = v;
  if (k === 'status' && choice !== 'clear')
    out.priority = {
      tier: choice,
      by: values.by,
      on: new Date().toISOString().slice(0, 10),
      ...(values.note?.trim() ? { note: values.note.trim() } : {}),
    };
}
writeFileSync(file, stringify(out, { lineWidth: 80 }));
console.log(choice === 'clear' ? `Cleared the priority on ${id}.` : `${id}: ${choice}, set by ${values.by}.`);
