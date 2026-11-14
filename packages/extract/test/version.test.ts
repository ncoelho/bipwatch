import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changelogTimeline, specVersionTimeline, versionAt } from '../src/version.ts';
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

describe('changelog timeline', () => {
  it('reads mediawiki and markdown changelogs, oldest first', () => {
    const wiki = [
      'text',
      '== Changelog ==',
      '',
      'Intro.',
      '',
      "* '''1.0.1''' (2024-06-22):",
      '** fix',
      "* '''1.0.0''' (2024-05-08):",
      '** Initial',
      '',
      '== Acknowledgements ==',
      "* '''9.9.9''' (2030-01-01): not a changelog entry",
    ].join('\n');
    const t = changelogTimeline(wiki);
    expect(t.map((x) => x.version)).toEqual(['1.0.0', '1.0.1']);
    expect(versionAt(t, new Date('2024-03-01'))).toBe('0.0.0');
    expect(versionAt(t, new Date('2025-12-12'))).toBe('1.0.1');
    const md = '## Changelog\n\n* __1.0.0__ (2026-05-22):\n    * Complete.\n\n[^0]: note';
    expect(changelogTimeline(md)).toEqual([{ at: Date.parse('2026-05-22T00:00:00Z'), version: '1.0.0' }]);
    // BIP 77's style: a dash, the version, a space and the date, items indented below.
    const dash = '## Changelog\n\n- 0.2.0 2025-07-08\n    - Change fragment delimiter.\n- 0.1.0 2025-05-28\n    - First merged Draft version of BIP 77\n';
    expect(changelogTimeline(dash).map((x) => x.version)).toEqual(['0.1.0', '0.2.0']);
    expect(versionAt(changelogTimeline(dash), new Date('2025-06-15'))).toBe('0.1.0');
    expect(changelogTimeline('no changelog here')).toEqual([]);
  });

  it('prefers the changelog over header history', async () => {
    writeFileSync(
      join(repo, 'bip-0352.mediawiki'),
      "<pre>\n  BIP: 352\n  Title: Silent Payments\n  Status: Draft\n  Type: Specification\n  Version: 1.1.2\n</pre>\n== Changelog ==\n* '''1.1.2''' (2026-10-25):\n* '''1.0.0''' (2024-05-08):\n",
    );
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.test' };
    execFileSync('git', ['-C', repo, 'commit', '-qam', 'changelog'], { env });
    const t = await specVersionTimeline(repo, BIP352, 'master');
    expect(t.map((x) => x.version)).toEqual(['1.0.0', '1.1.2']);
    expect(versionAt(t, new Date('2025-06-01'))).toBe('1.0.0');
  });
});
