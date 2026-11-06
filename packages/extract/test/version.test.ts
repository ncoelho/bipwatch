import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { specVersionTimeline, versionAt } from '../src/version.ts';
import { BIP352 } from './helpers.ts';

const repo = mkdtempSync(join(tmpdir(), 'bipwatch-version-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function commit(header: string, date: string) {
  writeFileSync(join(repo, 'bip-0352.mediawiki'), `<pre>\n  BIP: 352\n  Title: Silent Payments\n  Status: Draft\n  Type: Specification\n${header}</pre>\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.test', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', date], { env });
}

describe('spec version at a date', () => {
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'master']);
  commit('', '2024-05-08T12:00:00Z'); // merged without a Version header
  commit('  Version: 1.0.0\n', '2025-02-01T12:00:00Z');
  commit('  Version: 1.1.2\n', '2026-10-25T12:00:00Z');

  it('reads the Version header at the last commit before the date', async () => {
    const t = await specVersionTimeline(repo, BIP352, 'master');
    expect(t.map((x) => x.version)).toEqual(['0.0.0', '1.0.0', '1.1.2']);
    expect(versionAt(t, new Date('2022-03-28'))).toBe('0.0.0'); // before the spec existed
    expect(versionAt(t, new Date('2024-12-01'))).toBe('0.0.0'); // spec without a version
    expect(versionAt(t, new Date('2025-06-01'))).toBe('1.0.0');
    expect(versionAt(t, new Date('2026-11-01'))).toBe('1.1.2');
    expect(versionAt(t, null)).toBe('1.1.2');
  });
});
