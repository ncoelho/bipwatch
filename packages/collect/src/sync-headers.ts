import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findDataDir, listBipFolders } from '@bipwatch/data';
import { Document, isMap, isScalar, parseDocument, type Pair, type Scalar } from 'yaml';
import { BIPS_BRANCH, bipsRepoDir, git, showFile, updateBipsRepo } from './bips/git.ts';
import { latestChangelogVersion } from './bips/changelog.ts';
import { parseHeader, type SpecHeader } from './bips/header.ts';
import { specHistory, statusSince } from './bips/history.ts';

/**
 * Re-syncs the facts in every data/bips/<NNNN>/bip.yaml from its spec header
 * (SPEC 5 rule 8). A file is rewritten when a header fact differs or the spec
 * file has a newer commit than spec.revision; then spec.revision moves to
 * the last commit that touched the spec and spec.synced to today. Comments and the bipwatch block are left alone.
 */

/** Header facts copied into bip.yaml, in file order. */
const FACTS = [
  'title',
  'layer',
  'type',
  'status',
  'status_since',
  'version',
  'assigned',
  'license',
  'authors',
  'requires',
  'discussion',
] as const;
type Fact = (typeof FACTS)[number];

type Discussion = { date?: string; url: string; title?: string }[];

export interface SyncChange {
  number: number;
  file: string;
  fields: string[];
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  revision: string;
}

export interface SyncOptions {
  dir?: string;
  dataDir?: string;
  /** Revision to read headers at. Default: origin/master after a fetch. */
  ref?: string;
  today?: string;
  /** Report without writing. */
  dryRun?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Discussion entries are matched by URL. If the header lists the same URLs
 * in the same order, the record (with its hand-written titles) is kept.
 * Otherwise entries are rebuilt from the header, reusing the record's entry
 * for any URL it already has.
 */
export function mergeDiscussion(current: Discussion | undefined, header: Discussion | undefined) {
  if (!header?.length) return current?.length ? undefined : current;
  if (same(current?.map((d) => d.url), header.map((d) => d.url))) return current;
  const byUrl = new Map((current ?? []).map((d) => [d.url, d]));
  return header.map((d) => byUrl.get(d.url) ?? d);
}

function desiredFacts(h: SpecHeader, current: Record<string, unknown>, since: string | undefined): Record<Fact, unknown> {
  return {
    title: h.title,
    layer: h.layer,
    type: h.type,
    status: h.status,
    status_since: since,
    version: h.version,
    assigned: h.assigned,
    license: h.license,
    authors: h.authors,
    requires: h.requires,
    discussion: mergeDiscussion(current.discussion as Discussion | undefined, h.discussion),
  };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** `key: value` as YAML, top level, no trailing newline. */
function render(key: string, value: unknown): string {
  const doc = new Document({});
  doc.set(key, doc.createNode(value, { flow: key === 'requires' || key === 'related' }));
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

function topPair(doc: Document, key: string): Pair | undefined {
  if (!isMap(doc.contents)) throw new Error('bip.yaml is not a mapping');
  return doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair | undefined;
}

function lineStart(text: string, i: number) {
  return text.lastIndexOf('\n', i - 1) + 1;
}

/**
 * Text edits that set one top-level fact, so the rest of the file (comments,
 * folding, list style) stays byte-for-byte the same.
 */
function factEdit(text: string, doc: Document, key: Fact, value: unknown): Edit {
  const pair = topPair(doc, key);
  if (pair) {
    const start = (pair.key as Scalar).range![0];
    // Block collections' ranges include the trailing newline; keep it.
    let end = (pair.value as Scalar).range![1];
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (value === undefined) {
      const from = lineStart(text, start);
      const to = text.indexOf('\n', end - 1) + 1 || text.length;
      return { start: from, end: to, text: '' };
    }
    return { start, end, text: render(key, value) };
  }
  // New key: insert before the next fact present in the file, else before spec.
  const later = [...FACTS.slice(FACTS.indexOf(key) + 1), 'spec'];
  const next = later.map((k) => topPair(doc, k)).find(Boolean)!;
  const at = lineStart(text, (next.key as Scalar).range![0]);
  return { start: at, end: at, text: `${render(key, value)}\n` };
}

function scalarEdit(doc: Document, path: string[], value: string): Edit {
  const node = doc.getIn(path, true) as Scalar;
  return { start: node.range![0], end: node.range![1], text: value };
}

function applyEdits(text: string, edits: Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

export async function syncHeaders(opts: SyncOptions = {}): Promise<SyncChange[]> {
  const dir = opts.dir ?? bipsRepoDir();
  const dataDir = opts.dataDir ?? findDataDir();
  const ref = opts.ref ?? (await updateBipsRepo(dir));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const changes: SyncChange[] = [];

  for (const folder of listBipFolders(dataDir)) {
    const file = join(dataDir, 'bips', folder, 'bip.yaml');
    const text0 = readFileSync(file, 'utf8');
    const doc = parseDocument(text0);
    const current = doc.toJS() as Record<string, unknown> & { number: number; spec: { path: string } };

    // Follow a mediawiki <-> markdown conversion.
    const candidates = [current.spec.path, `bip-${folder}.mediawiki`, `bip-${folder}.md`];
    let path: string | undefined;
    let text: string | null = null; // spec file
    for (const p of [...new Set(candidates)]) {
      text = await showFile(dir, ref, p);
      if (text !== null) {
        path = p;
        break;
      }
    }
    if (!path || text === null) throw new Error(`BIP ${current.number}: no spec file at ${ref}`);

    // Some specs keep their version only in the Changelog section (BIP 54).
    const parsed = parseHeader(text);
    const header = { ...parsed, version: parsed.version ?? latestChangelogVersion(text) };
    if (header.number !== current.number) {
      throw new Error(`${path} says BIP ${header.number}, record says ${current.number}`);
    }

    // When it took its status, from the spec's history on the branch.
    const since = statusSince(await specHistory(dir, ref, path, text));
    const want = desiredFacts(header, current, since);
    const fields = FACTS.filter((k) => !same(current[k], want[k]));
    if (path !== current.spec.path) fields.push('spec.path' as never);
    // A spec edit outside the header still moves the revision the claims and
    // pages read the spec at.
    const revision = (await git(dir, 'log', '-1', '--format=%H', ref, '--', path)).trim();
    const moved = revision !== (current.spec as { revision?: string }).revision;
    if (!fields.length && !moved) continue;
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    const edits: Edit[] = [];
    if (moved && !fields.length) {
      from['spec.revision'] = (current.spec as { revision?: string }).revision;
      to['spec.revision'] = revision;
    }
    for (const k of fields) {
      if (k === ('spec.path' as Fact)) {
        from[k] = current.spec.path;
        to[k] = path;
        edits.push(scalarEdit(doc, ['spec', 'path'], path));
      } else {
        from[k] = current[k];
        to[k] = want[k];
        edits.push(factEdit(text0, doc, k, want[k]));
      }
    }
    edits.push(scalarEdit(doc, ['spec', 'revision'], revision));
    edits.push(scalarEdit(doc, ['spec', 'synced'], today));

    if (!opts.dryRun) writeFileSync(file, applyEdits(text0, edits));
    changes.push({ number: current.number, file, fields: fields.length ? fields : ['spec.revision' as never], from, to, revision });
  }
  return changes;
}

/** Markdown summary used as the pull request body. */
export function summarize(changes: SyncChange[], dataDir: string): string {
  const lines = [
    'Header facts changed upstream in bitcoin/bips. Generated by `npm run sync-headers`.',
    '',
  ];
  for (const c of changes) {
    lines.push(
      `### BIP ${c.number}`,
      '',
      `\`${c.file.replace(dataDir, 'data')}\` at [\`${c.revision.slice(0, 7)}\`](https://github.com/bitcoin/bips/commit/${c.revision})`,
      '',
      '| Field | Was | Now |',
      '|---|---|---|',
      ...c.fields.map(
        (f) => `| ${f} | \`${JSON.stringify(c.from[f]) ?? '—'}\` | \`${JSON.stringify(c.to[f]) ?? '—'}\` |`,
      ),
      '',
    );
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      bips: { type: 'string' },
      ref: { type: 'string' },
      'dry-run': { type: 'boolean' },
      summary: { type: 'string' },
    },
  });
  const dataDir = findDataDir(process.env.INIT_CWD);
  const dir = values.bips ? join(process.env.INIT_CWD ?? process.cwd(), values.bips) : undefined;
  try {
    const changes = await syncHeaders({
      dir,
      dataDir,
      ref: values.ref,
      dryRun: values['dry-run'],
    });
    if (!changes.length) {
      console.log(`All ${listBipFolders(dataDir).length} bip.yaml files match their spec headers (${BIPS_BRANCH}).`);
    } else {
      for (const c of changes) console.log(`BIP ${c.number}: ${c.fields.join(', ')} -> ${c.revision.slice(0, 7)}`);
      if (values.summary) writeFileSync(values.summary, summarize(changes, dataDir));
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
