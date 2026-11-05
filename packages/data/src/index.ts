import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { BipBundle, BipRecord, Claim, NeedsAssessment } from './types.ts';

export * from './types.ts';

/**
 * Finds the data directory by walking up from `start` until it sees
 * data/schemas. Works from the repo root, from site/, and from CI.
 * BIPWATCH_DATA overrides the search (useful once data/ is its own repo).
 */
export function findDataDir(start: string = process.cwd()): string {
  if (process.env.BIPWATCH_DATA) return resolve(process.env.BIPWATCH_DATA);
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'data');
    if (existsSync(join(candidate, 'schemas'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No data/schemas directory found above ${start}`);
    dir = parent;
  }
}

export const folderFor = (n: number) => String(n).padStart(4, '0');

function readYaml<T>(file: string): T {
  return parse(readFileSync(file, 'utf8')) as T;
}

/** BIP folder names under data/bips, e.g. ["0352", "0375"]. */
export function listBipFolders(dataDir = findDataDir()): string[] {
  const bipsDir = join(dataDir, 'bips');
  if (!existsSync(bipsDir)) return [];
  return readdirSync(bipsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function loadBip(folder: string, dataDir = findDataDir()): BipBundle {
  const base = join(dataDir, 'bips', folder);
  const bip = readYaml<BipRecord>(join(base, 'bip.yaml'));
  const claimsDir = join(base, 'claims');
  const claims = existsSync(claimsDir)
    ? readdirSync(claimsDir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => readYaml<Claim>(join(claimsDir, f)))
    : [];
  const needsFile = join(base, 'needs.yaml');
  const needs = existsSync(needsFile) ? readYaml<NeedsAssessment>(needsFile) : null;
  return { bip, claims, needs };
}

export function loadAll(dataDir = findDataDir()): BipBundle[] {
  return listBipFolders(dataDir).map((f) => loadBip(f, dataDir));
}
