import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findDataDir } from '@bipwatch/data';
import { cleanSender, cleanSubject, escapeMid, ownText, parseMessage, threadRoot, type ListMessage } from '../email.ts';
import type { Collector, DocumentInput, RawItem } from '../types.ts';

/**
 * bitcoin-dev mailing list, from the public-inbox archive at
 * gnusha.org/pi/bitcoindev (2011 to now: the sourceforge, linuxfoundation and
 * Google Groups eras). The archive is a v1 public-inbox git repository: each
 * commit adds one message file. A bare clone is kept next to this repo and
 * fetched each run; the cursor is the last commit stored.
 *
 * Stored per message: Message-ID, threading headers, sender name (no
 * address), date, subject, list and the plain-text body. Transport headers
 * and attachments are dropped to keep Neon small.
 */

const run = promisify(execFile);
export const ARCHIVE_REMOTE = 'git://gnusha.org/pi-bitcoindev';
export const ARCHIVE_WEB = 'https://gnusha.org/pi/bitcoindev/';

export function archiveDir(): string {
  if (process.env.BITCOINDEV_ARCHIVE) return resolve(process.env.BITCOINDEV_ARCHIVE);
  return join(dirname(dirname(findDataDir())), 'bitcoindev-archive.git');
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

/** Bare clone if missing, else fetch. Returns the tip of master. */
export async function updateArchive(dir = archiveDir(), remote = ARCHIVE_REMOTE): Promise<string> {
  if (!existsSync(join(dir, 'HEAD'))) {
    await run('git', ['clone', '--quiet', '--bare', remote, dir], { maxBuffer: 64 * 1024 * 1024 });
  } else {
    await git(dir, 'fetch', '--quiet', 'origin', '+refs/heads/master:refs/heads/master');
  }
  return (await git(dir, 'rev-parse', 'refs/heads/master')).trim();
}

/** Reads many blobs through one `git cat-file --batch` process. */
export class BlobReader {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private waiting: ((b: Buffer) => void) | null = null;
  private want: { size: number } | null = null;
  private failed: Error | null = null;

  constructor(dir: string) {
    this.proc = spawn('git', ['-C', dir, 'cat-file', '--batch']);
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    this.proc.on('error', (err) => (this.failed = err));
  }

  private drain() {
    if (!this.waiting) return;
    if (!this.want) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString();
      this.buf = this.buf.subarray(nl + 1);
      const m = header.match(/^\S+ blob (\d+)$/);
      if (!m) {
        const done = this.waiting;
        this.waiting = null;
        this.failed = new Error(`cat-file: ${header}`);
        done(Buffer.alloc(0));
        return;
      }
      this.want = { size: Number(m[1]) };
    }
    if (this.buf.length < this.want.size + 1) return;
    const blob = this.buf.subarray(0, this.want.size);
    this.buf = this.buf.subarray(this.want.size + 1);
    this.want = null;
    const done = this.waiting;
    this.waiting = null;
    done(Buffer.from(blob));
  }

  read(oid: string): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting = (b) => (this.failed ? reject(this.failed) : resolve(b));
      this.proc.stdin.write(`${oid}\n`);
      this.drain();
    });
  }

  close() {
    this.proc.stdin.end();
  }
}

/** Commits after `cursor` with the blob each one added, oldest first. */
export async function newMessages(
  dir: string,
  tip: string,
  cursor: string | null,
): Promise<{ commit: string; blob: string; date: string }[]> {
  const range = cursor ? `${cursor}..${tip}` : tip;
  const out = await git(dir, 'log', '--reverse', '--no-abbrev', '--raw', '--format=C %H %aI', range);
  const result: { commit: string; blob: string; date: string }[] = [];
  let current: { commit: string; date: string } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('C ')) {
      const [, commit, date] = line.split(' ');
      current = { commit, date };
    } else if (line.startsWith(':') && current) {
      // ":000000 100644 <old> <new> A\tpath"; deletions (spam removal) are skipped.
      const [meta] = line.split('\t');
      const parts = meta.split(' ');
      if (parts[4] === 'A' || parts[4] === 'M') {
        result.push({ commit: current.commit, blob: parts[3], date: current.date });
      }
    }
  }
  return result;
}

export function messageUrl(mid: string): string {
  return `${ARCHIVE_WEB}${escapeMid(mid)}/`;
}

export function mailingListCollector(opts: { dir?: string; remote?: string; ref?: string } = {}): Collector {
  const dir = opts.dir ?? archiveDir();

  return {
    source: 'mailing-list',

    async *fetch(cursor) {
      const tip = opts.ref ? (await git(dir, 'rev-parse', opts.ref)).trim() : await updateArchive(dir, opts.remote);
      const todo = await newMessages(dir, tip, cursor);
      const reader = new BlobReader(dir);
      try {
        for (const { commit, blob, date } of todo) {
          const msg = await parseMessage(await reader.read(blob));
          if (!msg) continue;
          if (!msg.date) msg.date = date;
          yield {
            item: {
              external_id: msg.message_id,
              url: messageUrl(msg.message_id),
              content_type: 'application/json',
              body: JSON.stringify(msg),
              meta: { commit },
            },
            cursor: commit,
          };
        }
      } finally {
        reader.close();
      }
    },

    normalize(raw: RawItem): DocumentInput[] {
      const m = JSON.parse(raw.body) as ListMessage;
      return [
        {
          external_id: m.message_id,
          thread_key: threadRoot(m),
          title: cleanSubject(m.subject) || undefined,
          // Raw items stored before the via-cleanup still hold the rewritten name.
          author: cleanSender(m.from) ?? undefined,
          posted_at: m.date ? new Date(m.date) : undefined,
          body_text: ownText(m.text),
          url: raw.url ?? messageUrl(m.message_id),
        },
      ];
    },
  };
}
