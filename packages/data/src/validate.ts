/**
 * Validates the open data layer.
 *
 *   npm run validate                      schema + consistency checks
 *   npm run validate -- --bips ../bips    also match spec quotes against a
 *                                         local clone of bitcoin/bips at the
 *                                         revision each claim cites
 *
 * Exits 1 on any error. Warnings never fail the run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalName, findDataDir, folderFor, loadPeople } from './index.ts';
import type { BipRecord, Claim, NeedsAssessment } from './types.ts';

type Level = 'error' | 'warn';
const findings: { level: Level; file: string; msg: string }[] = [];
const report = (level: Level, file: string, msg: string) => findings.push({ level, file, msg });

const args = process.argv.slice(2);
const bipsFlag = args.indexOf('--bips');
// npm runs workspace scripts from packages/data, so resolve relative paths
// against the directory the user ran npm from (INIT_CWD).
const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const bipsArg = bipsFlag >= 0 ? args[bipsFlag + 1] : process.env.BIPS_REPO;
const bipsRepo = bipsArg ? resolve(invokedFrom, bipsArg) : undefined;
if (bipsRepo && !existsSync(join(bipsRepo, '.git'))) {
  console.error(`ERROR  --bips ${bipsArg}: no git repository at ${bipsRepo}`);
  process.exit(1);
}

const dataDir = findDataDir();
const rel = (p: string) => p.replace(dataDir + '/', 'data/');

// ---- schemas ---------------------------------------------------------------
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({
  allErrors: true,
  strict: true,
  // if/then blocks require properties that are declared on the parent schema.
  strictRequired: false,
  // Fields like reviewed_by are ["string", "null"].
  allowUnionTypes: true,
});
(addFormats as unknown as typeof addFormats.default)(ajv);
const schemaDir = join(dataDir, 'schemas');
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), 'utf8')), f);
}
const validators = {
  bip: ajv.getSchema('bip.schema.json')!,
  claim: ajv.getSchema('claim.schema.json')!,
  needs: ajv.getSchema('needs.schema.json')!,
  people: ajv.getSchema('people.schema.json')!,
};

function check<T>(kind: keyof typeof validators, file: string): T | null {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    report('error', rel(file), `YAML does not parse: ${(e as Error).message.split('\n')[0]}`);
    return null;
  }
  const validate = validators[kind];
  if (!validate(doc)) {
    for (const err of validate.errors ?? []) {
      // Skip the generic "must match then schema" wrapper; the specific error is also listed.
      if (err.keyword === 'if') continue;
      const extra = err.keyword === 'additionalProperties' ? `: "${err.params.additionalProperty}"` : '';
      const allowed = err.keyword === 'enum' ? ` (${(err.params.allowedValues as unknown[]).join(', ')})` : '';
      report('error', rel(file), `${err.instancePath || '(root)'} ${err.message}${extra}${allowed}`);
    }
    return null;
  }
  return doc as T;
}

// ---- spec quote matching -----------------------------------------------------
const normalize = (s: string) =>
  s
    .replace(/'''|''/g, '') // mediawiki bold/italic
    .replace(/\s+/g, ' ')
    .trim();

const specCache = new Map<string, string | null>();
function specText(revision: string, path: string): string | null {
  const key = `${revision}:${path}`;
  if (!specCache.has(key)) {
    try {
      const out = execFileSync('git', ['-C', bipsRepo!, 'show', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      });
      specCache.set(key, normalize(out));
    } catch {
      specCache.set(key, null);
    }
  }
  return specCache.get(key)!;
}

// ---- people --------------------------------------------------------------------
const peopleFile = join(dataDir, 'people.yaml');
if (existsSync(peopleFile)) {
  const people = check<{ people: { name: string; aliases: string[] }[] }>('people', peopleFile);
  const seen = new Map<string, string>();
  for (const p of people?.people ?? []) {
    for (const n of [p.name, ...p.aliases]) {
      const key = n.toLowerCase();
      if (seen.has(key) && seen.get(key) !== p.name)
        report('error', rel(peopleFile), `"${n}" belongs to both ${seen.get(key)} and ${p.name}`);
      seen.set(key, p.name);
    }
  }
}
const canonical = canonicalName(loadPeople(dataDir));

// ---- walk the data -------------------------------------------------------------
const bipsDir = join(dataDir, 'bips');
const folders = existsSync(bipsDir)
  ? readdirSync(bipsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];
const known = new Set(folders);
let claimCount = 0;
let quotesMatched = 0;

for (const folder of folders) {
  const base = join(bipsDir, folder);
  if (!/^\d{4}$/.test(folder)) {
    report('error', rel(base), 'BIP folders must be four digits, e.g. 0352');
    continue;
  }
  const n = Number(folder);
  const bipFile = join(base, 'bip.yaml');
  if (!existsSync(bipFile)) {
    report('error', rel(base), 'missing bip.yaml');
    continue;
  }
  const bip = check<BipRecord>('bip', bipFile);
  if (bip) {
    if (bip.number !== n) report('error', rel(bipFile), `number ${bip.number} does not match folder ${folder}`);
    if (bip.spec.path !== `bip-${folder}.mediawiki` && bip.spec.path !== `bip-${folder}.md`)
      report('error', rel(bipFile), `spec.path ${bip.spec.path} does not match folder ${folder}`);
    for (const r of [...(bip.requires ?? []), ...(bip.related ?? [])]) {
      if (!known.has(folderFor(r)) && (bip.related ?? []).includes(r))
        report('warn', rel(bipFile), `related BIP ${r} has no folder yet`);
    }
    if (bip.bipwatch.tracked && !bip.bipwatch.category)
      report('error', rel(bipFile), 'tracked BIPs need bipwatch.category');
    if (!bip.bipwatch.tracked && bip.bipwatch.aliases?.length)
      report('warn', rel(bipFile), 'bipwatch.aliases is only used for tracked BIPs');
  }

  // claims
  const claimsDir = join(base, 'claims');
  const ids = new Set<string>();
  if (existsSync(claimsDir)) {
    for (const f of readdirSync(claimsDir).filter((f) => f.endsWith('.yaml')).sort()) {
      const file = join(claimsDir, f);
      claimCount++;
      const claim = check<Claim>('claim', file);
      if (!claim) continue;
      const stem = basename(f, '.yaml');
      if (claim.id !== stem) report('error', rel(file), `id "${claim.id}" does not match filename "${stem}"`);
      if (claim.bip !== n) report('error', rel(file), `bip ${claim.bip} does not match folder ${folder}`);
      if (ids.has(claim.id)) report('error', rel(file), `duplicate id ${claim.id}`);
      ids.add(claim.id);

      if (claim.provenance.reviewed_by === null && claim.provenance.reviewed)
        report('error', rel(file), 'reviewed date set without a reviewer');
      if (claim.area && !['task', 'open-question', 'objection'].includes(claim.kind))
        report('error', rel(file), 'area is for tasks, open questions and objections only');
      if (claim.part_of && !['task', 'open-question', 'objection'].includes(claim.kind))
        report('error', rel(file), 'part_of is for tasks, open questions and objections only');
      if (claim.part_of && new RegExp(`^BIP[ -]?0*${claim.bip}$`, 'i').test(claim.part_of.trim()))
        report('error', rel(file), 'part_of names the BIP itself; leave it out');
      if (claim.kind !== 'stance' && (claim.scope || claim.change))
        report('error', rel(file), 'scope and change are for stance claims only');
      if (claim.change && claim.scope === 'proposal')
        report('error', rel(file), 'a proposal-scoped stance has no change; use scope change or implementation');
      if (claim.subject && canonical(claim.subject.name) !== claim.subject.name)
        report('error', rel(file), `subject "${claim.subject.name}" is an alias in people.yaml; use "${canonical(claim.subject.name)}"`);

      const s = claim.source;
      if (s.type === 'spec') {
        if (!s.revision) report('error', rel(file), 'spec sources must cite a revision');
        else if (bipsRepo && s.quote && bip) {
          const text = specText(s.revision, bip.spec.path);
          if (text === null) report('error', rel(file), `revision ${s.revision.slice(0, 7)} not found in ${bipsRepo}`);
          else if (!text.includes(normalize(s.quote)))
            report('error', rel(file), `quote not found in ${bip.spec.path}@${s.revision.slice(0, 7)}`);
          else {
            quotesMatched++;
            if (!s.verified) report('warn', rel(file), 'quote matches the spec; set source.verified: true');
          }
        }
      } else if (s.verified && !/^(model|bot):/.test(claim.provenance.extracted_by)) {
        // Extractors match quotes against the archived document before writing
        // a claim; this checkout cannot re-check that, but a hand-set flag has
        // nothing behind it.
        report('warn', rel(file), `verified: true on a ${s.type} source set by hand; only an extractor that matched the archived document should set it`);
      }
    }
  }

  // needs
  const needsFile = join(base, 'needs.yaml');
  if (existsSync(needsFile)) {
    const needs = check<NeedsAssessment>('needs', needsFile);
    if (needs) {
      if (needs.bip !== n) report('error', rel(needsFile), `bip ${needs.bip} does not match folder ${folder}`);
      for (const [dim, d] of Object.entries(needs.dimensions)) {
        for (const id of d.evidence)
          if (!ids.has(id)) report('error', rel(needsFile), `${dim} cites unknown claim "${id}"`);
        if (d.score !== null && d.evidence.length === 0)
          report('error', rel(needsFile), `${dim} has a score but no evidence`);
      }
    }
  } else if (bip?.bipwatch.tracked) {
    report('warn', rel(base), 'tracked BIP has no needs.yaml yet');
  }
}

// ---- report ----------------------------------------------------------------------
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');
for (const f of [...errors, ...warns]) console.log(`${f.level === 'error' ? 'ERROR' : 'warn '}  ${f.file}  ${f.msg}`);
console.log(
  `\n${folders.length} BIPs, ${claimCount} claims` +
    (bipsRepo ? `, ${quotesMatched} spec quotes matched` : ' (spec quotes not checked; pass --bips <path>)') +
    ` · ${errors.length} errors, ${warns.length} warnings`,
);
process.exit(errors.length ? 1 : 0);
