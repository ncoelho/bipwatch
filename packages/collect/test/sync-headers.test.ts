// Header sync against a throwaway "bitcoin/bips" repo and a copy of the real
// BIP 352 record. No network.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDataDir } from '@bipwatch/data';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeDiscussion, summarize, syncHeaders } from '../src/sync-headers.ts';

const header352 = readFileSync(new URL('./fixtures/bip-0352.header.mediawiki', import.meta.url), 'utf8');
let root: string;
let repo: string;
let dataDir: string;
let yamlFile: string;

function g(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  }).trim();
}

function commitSpec(text: string, msg: string): string {
  writeFileSync(join(repo, 'bip-0352.mediawiki'), `${text}\n\n== Abstract ==\n`);
  g('add', '-A');
  g('commit', '-q', '-m', msg);
  return g('rev-parse', 'HEAD');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bipwatch-sync-'));
  repo = join(root, 'bips');
  dataDir = join(root, 'data');
  mkdirSync(repo);
  g('init', '-q', '-b', 'master');
  mkdirSync(join(dataDir, 'bips'), { recursive: true });
  cpSync(join(findDataDir(), 'bips', '0352'), join(dataDir, 'bips', '0352'), { recursive: true });
  yamlFile = join(dataDir, 'bips', '0352', 'bip.yaml');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('syncHeaders', () => {
  it('moves only the revision when the spec changed outside its header', async () => {
    const sha = commitSpec(header352, 'Add BIP 352');
    const before = parse(readFileSync(yamlFile, 'utf8'));
    const changes = await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-01' });
    // The throwaway repo's single commit also dates the status (status_since).
    expect(changes).toMatchObject([{ number: 352, fields: ['status_since'], revision: sha }]);
    const after = parse(readFileSync(yamlFile, 'utf8'));
    expect(after.spec).toMatchObject({ revision: sha, synced: '2026-12-01' });
    expect(after.status_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const strip = ({ status_since: _, spec: __, ...r }: Record<string, unknown>) => r;
    expect(strip(after)).toEqual(strip(before));
  });

  it('leaves a record alone when the header and revision match', async () => {
    const before = readFileSync(yamlFile, 'utf8');
    expect(await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-01' })).toEqual([]);
    expect(readFileSync(yamlFile, 'utf8')).toBe(before);
  });

  it('rewrites only the changed facts, the revision and the sync date', async () => {
    const before = readFileSync(yamlFile, 'utf8');
    const changed = header352
      .replace('Status: Complete', 'Status: Deployed')
      .replace('Version: 1.1.2', 'Version: 1.2.0')
      .replace(
        '  Version:',
        '              2026-11-20: https://delvingbitcoin.org/t/sp-update/1 [delving] An update\n  Version:',
      );
    const sha = commitSpec(changed, 'BIP352: mark deployed');

    const changes = await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-01' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      number: 352,
      fields: ['status', 'version', 'discussion'],
      revision: sha,
      from: { status: 'Complete', version: '1.1.2' },
      to: { status: 'Deployed', version: '1.2.0' },
    });

    const after = readFileSync(yamlFile, 'utf8');
    const record = parse(after);
    expect(record.status).toBe('Deployed');
    expect(record.spec).toMatchObject({ revision: sha, synced: '2026-12-01' });
    // Hand-written titles survive; the new entry comes from the header.
    expect(record.discussion[0].title).toBe('Original proposal (gist)');
    expect(record.discussion.at(-1)).toEqual({
      date: '2026-11-20',
      url: 'https://delvingbitcoin.org/t/sp-update/1',
      title: 'An update',
    });
    // Comments, flow-style lists and the bipwatch block are untouched.
    expect(after).toContain('# Copied from the spec header at spec.revision.');
    expect(after).toContain('requires: [340, 341, 350]');
    expect(after.slice(after.indexOf('bipwatch:'))).toBe(before.slice(before.indexOf('bipwatch:')));

    expect(summarize(changes, dataDir)).toContain('| status | `"Complete"` | `"Deployed"` |');
  });

  it('is a no-op on the next run', async () => {
    expect(await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-02' })).toEqual([]);
  });

  it('follows a conversion to markdown', async () => {
    const md = readFileSync(join(repo, 'bip-0352.mediawiki'), 'utf8')
      .replace('<pre>', '```')
      .replace('</pre>', '```');
    g('rm', '-q', 'bip-0352.mediawiki');
    writeFileSync(join(repo, 'bip-0352.md'), md);
    g('add', '-A');
    g('commit', '-q', '-m', 'BIP352: convert to markdown');
    const [c] = await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-03' });
    expect(c.fields).toEqual(['spec.path']);
    expect(parse(readFileSync(yamlFile, 'utf8')).spec.path).toBe('bip-0352.md');
  });
});

describe('mergeDiscussion', () => {
  const a = { url: 'https://a.test', title: 'mine' };
  it('keeps the record when URLs match', () => {
    expect(mergeDiscussion([a], [{ url: 'https://a.test', title: 'theirs' }])).toEqual([a]);
  });
  it('drops the list when the header has none', () => {
    expect(mergeDiscussion([a], undefined)).toBeUndefined();
  });
});

describe('syncHeaders without a Version header', () => {
  it('takes the version from the Changelog section (as BIP 54 keeps it)', async () => {
    const noHeader = header352.replace(/^\s*Version: .*\n/m, '');
    // The earlier tests left the spec converted to markdown; go back to one file.
    g('rm', '-q', 'bip-0352.md');
    commitSpec(`${noHeader}\n\n== Changelog ==\n\n* '''1.2.1''' (2026-12-02):\n** Fix a typo.\n* '''1.2.0''' (2026-11-20):\n** Deployed.`, 'Move version to changelog');
    await syncHeaders({ dir: repo, dataDir, ref: 'HEAD', today: '2026-12-02' });
    expect(parse(readFileSync(yamlFile, 'utf8')).version).toBe('1.2.1');
  });
});
