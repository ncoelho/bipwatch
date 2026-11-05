// Mailing-list collector on three real bitcoin-dev messages (addresses
// scrubbed): BIP 352's 2022 announcement, a reply in that thread, and the
// archive's first message from 2011. The archive is rebuilt as a throwaway
// public-inbox v1 git repo; no network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanSubject, escapeMid, messageIds, ownText, parseMessage } from '../src/email.ts';
import { mailingListCollector, messageUrl } from '../src/collectors/mailing-list.ts';
import { detectMentions, type MentionContext } from '../src/mentions.ts';
import type { RawItem, RawItemInput } from '../src/types.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ANNOUNCE = 'CAPv7TjbXm953U2h+-12MfJ24YqOM5Kcq77_xFTjVK+R2nf-nYg@mail.gmail.com';
const REPLY = 'CAGpPWDbiUOxrMwm9rdxpcDeOAPuMh_hKhrYJMjM5DFY0=a57Fg@mail.gmail.com';
const FIRST = 'BANLkTi=2VOhGTgX4HA_en00DATFbeWGVtg@mail.gmail.com';
const ctx: MentionContext = {
  aliases: new Map([
    ['silent payments', 352],
    ['silent payment', 352],
  ]),
};

let root: string;
let origin: string;
let clone: string;
const commits: Record<string, string> = {};

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'list',
      GIT_AUTHOR_EMAIL: 'list@example.test',
      GIT_COMMITTER_NAME: 'list',
      GIT_COMMITTER_EMAIL: 'list@example.test',
    },
  }).trim();
}

/** Adds a message the way public-inbox v1 does: sha1(Message-ID) as path. */
function addMessage(mid: string, body: Buffer): string {
  const h = createHash('sha1').update(mid).digest('hex');
  const path = join(origin, h.slice(0, 2), h.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  g(origin, 'add', '-A');
  g(origin, 'commit', '-q', '-m', mid);
  return g(origin, 'rev-parse', 'HEAD');
}

async function collect(cursor: string | null) {
  const c = mailingListCollector({ dir: clone, remote: origin });
  const out: { item: RawItemInput; cursor: string }[] = [];
  for await (const x of c.fetch(cursor)) out.push(x);
  return { c, out };
}

const asRaw = (item: RawItemInput): RawItem => ({
  ...item,
  id: 1,
  source: 'mailing-list',
  content_hash: 'x',
  fetched_at: new Date(),
  meta: item.meta ?? {},
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bipwatch-ml-'));
  origin = join(root, 'origin');
  clone = join(root, 'archive.git');
  mkdirSync(origin);
  g(origin, 'init', '-q', '-b', 'master');
  commits.first = addMessage(FIRST, fixture('ml-2011-first.eml'));
  commits.announce = addMessage(ANNOUNCE, fixture('ml-bip352-announce.eml'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('mailing-list collector', () => {
  it('clones the archive and yields every message oldest first', async () => {
    const { out } = await collect(null);
    expect(out.map((x) => x.item.external_id)).toEqual([FIRST, ANNOUNCE]);
    expect(out.map((x) => x.cursor)).toEqual([commits.first, commits.announce]);
    expect(out[1].item.url).toBe(`https://gnusha.org/pi/bitcoindev/${ANNOUNCE}/`);
  });

  it('stores no sender address and no transport headers', async () => {
    const { out } = await collect(null);
    const stored = JSON.parse(out[1].item.body);
    expect(Object.keys(stored).sort()).toEqual(
      ['date', 'from', 'list', 'message_id', 'references', 'subject', 'text'].sort(),
    );
    expect(stored.from).toBe('Ruben Somsen');
    expect(out[1].item.body).not.toContain('example.test>');
  });

  it('fetches new messages after the cursor', async () => {
    commits.reply = addMessage(REPLY, fixture('ml-bip352-reply.eml'));
    const { out } = await collect(commits.announce);
    expect(out.map((x) => x.item.external_id)).toEqual([REPLY]);
    expect((await collect(commits.reply)).out).toEqual([]);
  });

  it('threads the reply under the announcement and tags both as BIP 352', async () => {
    const { c, out } = await collect(null);
    const docs = out.map((x) => c.normalize(asRaw(x.item))[0]);
    const [first, announce, reply] = docs;
    expect(announce).toMatchObject({
      external_id: ANNOUNCE,
      thread_key: ANNOUNCE,
      title: 'Silent Payments – Non-interactive private payments with no on-chain overhead',
      author: 'Ruben Somsen',
    });
    expect(announce.posted_at?.toISOString()).toBe('2022-03-28T15:27:56.000Z');
    expect(reply).toMatchObject({ thread_key: ANNOUNCE, author: 'Billy' });
    expect(first).toMatchObject({ title: 'Preparing 0.3.23-rc1 release', author: 'Jeff Garzik' });

    const tags = (d: (typeof docs)[0]) =>
      detectMentions({ title: d.title, body: d.body_text }, ctx).map((m) => `${m.bip}:${m.method}`);
    expect(tags(announce)).toContain('352:alias');
    expect(tags(reply)).toContain('352:alias');
    expect(tags(first)).toEqual([]);
  });
});

describe('email helpers', () => {
  it('parses an old ISO-8859-1 message', async () => {
    const m = (await parseMessage(fixture('ml-2011-first.eml')))!;
    expect(m).toMatchObject({ message_id: FIRST, list: 'bitcoin-development.lists.sourceforge.net' });
    expect(m.references).toEqual([]);
  });

  it('cleans list tags and reply prefixes from subjects', () => {
    expect(cleanSubject('Re: [bitcoin-dev] Re: Fwd: BIP 352 update')).toBe('BIP 352 update');
    expect(cleanSubject('[bitcoindev] AW: Re[2]: Topic')).toBe('Topic');
  });

  it('keeps the author’s own words only', () => {
    const text = [
      'I agree with BIP 341 here.',
      '',
      'On Mon, 28 Mar 2022 at 17:27, Ruben Somsen <rx@example.test>',
      'wrote:',
      '> Silent payments, see BIP 352',
      '> more quote',
      '',
      'And one more point.',
      '',
      '-- ',
      'You received this message because you are subscribed to the Google Groups',
    ].join('\n');
    expect(ownText(text)).toBe('I agree with BIP 341 here.\n\nAnd one more point.');
  });

  it('escapes Message-IDs like public-inbox', () => {
    expect(escapeMid('a/b c@x')).toBe('a%2Fb%20c@x');
    expect(messageUrl(ANNOUNCE)).toBe(`https://gnusha.org/pi/bitcoindev/${ANNOUNCE}/`);
    expect(messageIds('<a@x> <b@y>\n <c@z>')).toEqual(['a@x', 'b@y', 'c@z']);
  });
});
