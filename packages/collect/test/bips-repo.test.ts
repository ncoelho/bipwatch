// Drives the bips-repo collector against throwaway local git repos: an
// "origin" standing in for bitcoin/bips and a blobless clone of it. No network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bipsForFiles, bipsRepoCollector, type WatchedBip } from '../src/collectors/bips-repo.ts';
import { detectMentions } from '../src/mentions.ts';
import type { RawItem, RawItemInput } from '../src/types.ts';

const header352 = readFileSync(new URL('./fixtures/bip-0352.header.mediawiki', import.meta.url), 'utf8');
const watched: WatchedBip[] = [
  { number: 352, paths: ['bip-0352.mediawiki', 'bip-0352.md', 'bip-0352/'] },
];

let root: string;
let origin: string;
let clone: string;

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ruben Somsen',
      GIT_AUTHOR_EMAIL: 'ruben@example.test',
      GIT_COMMITTER_NAME: 'Ruben Somsen',
      GIT_COMMITTER_EMAIL: 'ruben@example.test',
      GIT_AUTHOR_DATE: '2026-11-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-11-01T12:00:00Z',
    },
  }).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), content);
  }
  g(origin, 'add', '-A');
  g(origin, 'commit', '-q', '-m', message);
  return g(origin, 'rev-parse', 'HEAD');
}

async function collect(cursor: string | null, w: WatchedBip[] = watched) {
  const c = bipsRepoCollector({ dir: clone, remote: origin, watched: w });
  const out: { item: RawItemInput; cursor: string }[] = [];
  for await (const x of c.fetch(cursor)) out.push(x);
  return { c, out };
}

const asRaw = (item: RawItemInput): RawItem => ({
  ...item,
  id: 1,
  source: 'bips-repo',
  content_hash: 'x',
  fetched_at: new Date(),
  meta: item.meta ?? {},
});

const shas: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bipwatch-bips-'));
  origin = join(root, 'origin');
  clone = join(root, 'clone');
  mkdirSync(origin);
  g(origin, 'init', '-q', '-b', 'master');
  shas.add = commit(
    { 'bip-0352.mediawiki': `${header352}\n== Abstract ==\nSee BIP 341.\n`, 'README.mediawiki': 'index' },
    'Add BIP 352: Silent Payments\n\nLong description.',
  );
  shas.readme = commit({ 'README.mediawiki': 'index v2' }, 'README: list 352');
  shas.vectors = commit({ 'bip-0352/send_and_receive_test_vectors.json': '[]' }, 'BIP352: add test vectors');
  shas.other = commit({ 'bip-0999.mediawiki': 'other' }, 'Add BIP 999');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('bips-repo collector', () => {
  it('clones on first run and yields only commits touching watched BIPs, oldest first', async () => {
    const { out } = await collect(null);
    expect(out.map((x) => x.item.external_id)).toEqual([shas.add, shas.vectors]);
    expect(out.map((x) => JSON.parse(x.cursor))).toEqual([
      { sha: shas.add, bips: [352] },
      { sha: shas.vectors, bips: [352] },
    ]);
    expect(out[1].item.meta).toMatchObject({
      author: 'Ruben Somsen',
      subject: 'BIP352: add test vectors',
      files: ['bip-0352/send_and_receive_test_vectors.json'],
      bips: [352],
    });
  });

  it('stores the diff limited to watched paths, without emails', async () => {
    const { out } = await collect(null);
    const body = out[0].item.body;
    expect(body).toContain('diff --git a/bip-0352.mediawiki');
    expect(body).not.toContain('README.mediawiki');
    expect(body).toContain('Author: Ruben Somsen');
    expect(body).not.toContain('ruben@example.test');
  });

  it('normalizes a commit into one document tagged by link, not by diff text', async () => {
    const { c, out } = await collect(null);
    const [doc] = c.normalize(asRaw(out[0].item));
    expect(doc).toMatchObject({
      external_id: shas.add,
      thread_key: 'bip-352',
      author: 'Ruben Somsen',
      title: 'Add BIP 352: Silent Payments',
      url: `https://github.com/bitcoin/bips/commit/${shas.add}`,
    });
    expect(doc.body_text).toBe(
      `Add BIP 352: Silent Payments\n\nLong description.\n\nChanged files:\nhttps://github.com/bitcoin/bips/blob/${shas.add}/bip-0352.mediawiki`,
    );
    const mentions = detectMentions({ title: doc.title, body: doc.body_text }, { aliases: new Map() });
    // BIP 341 appears only inside the spec text in the diff, so it is not tagged.
    expect(mentions.map((m) => `${m.bip}:${m.method}`)).toEqual(['352:link', '352:number']);
  });

  it('fetches and resumes from the cursor', async () => {
    shas.edit = commit(
      { 'bip-0352.mediawiki': `${header352.replace('Version: 1.1.2', 'Version: 1.2.0')}\n` },
      'BIP352: bump to 1.2.0',
    );
    const { out } = await collect(shas.vectors);
    expect(out.map((x) => x.item.external_id)).toEqual([shas.edit]);
    expect((await collect(shas.edit)).out).toEqual([]);
  });

  it('maps files to BIPs', () => {
    expect(bipsForFiles(['bip-0352/x.json', 'bip-0352.md', 'bip-0035.mediawiki'], watched)).toEqual([352]);
    expect(bipsForFiles(['bip-03520.mediawiki'], watched)).toEqual([]);
  });

  it('fetches the whole history of a BIP added to the record later', async () => {
    const both: WatchedBip[] = [...watched, { number: 999, paths: ['bip-0999.mediawiki', 'bip-0999.md', 'bip-0999/'] }];
    shas.newer = commit({ 'bip-0352.mediawiki': `${header352}\nmore\n` }, 'BIP352: another edit');
    // The cursor from a run that covered only BIP 352, at shas.edit.
    const cursor = JSON.stringify({ sha: shas.edit, bips: [352] });
    const { out } = await collect(cursor, both);
    // BIP 999's commit from before the cursor, then 352's commit after it.
    expect(out.map((x) => x.item.external_id)).toEqual([shas.other, shas.newer]);
    expect(out.map((x) => JSON.parse(x.cursor))).toEqual([
      { sha: shas.edit, bips: [352, 999] }, // history-only: the sha stays put
      { sha: shas.newer, bips: [352, 999] },
    ]);
    // Next run: nothing new for either BIP.
    expect((await collect(out.at(-1)!.cursor, both)).out).toEqual([]);
  });

  it('reads a bare-sha cursor as covering every BIP watched now', async () => {
    const { out } = await collect(shas.newer);
    expect(out).toEqual([]);
  });
});
