import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findDataDir } from '@bipwatch/data';

const run = promisify(execFile);

export const BIPS_REMOTE = 'https://github.com/bitcoin/bips.git';
export const BIPS_BRANCH = 'master';

/** Runs git in `dir` and returns stdout. */
export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/**
 * Where the bitcoin/bips clone lives: BIPS_REPO, else ../bips next to this
 * repo (the same place the validator's --bips flag documents).
 */
export function bipsRepoDir(): string {
  if (process.env.BIPS_REPO) return resolve(process.env.BIPS_REPO);
  return join(dirname(dirname(findDataDir())), 'bips');
}

/**
 * Makes sure a blobless clone exists and is fetched. Returns the sha of the
 * remote branch tip.
 */
export async function updateBipsRepo(dir = bipsRepoDir(), remote = BIPS_REMOTE): Promise<string> {
  if (!existsSync(join(dir, '.git')) && !existsSync(join(dir, 'HEAD'))) {
    await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remote, dir], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } else {
    await git(dir, 'fetch', '--quiet', 'origin', BIPS_BRANCH);
  }
  return (await git(dir, 'rev-parse', `origin/${BIPS_BRANCH}`)).trim();
}

/** File contents at a revision, or null when the path does not exist there. */
export async function showFile(dir: string, rev: string, path: string): Promise<string | null> {
  try {
    return await git(dir, 'show', `${rev}:${path}`);
  } catch {
    return null;
  }
}
