// GitHub collector on recorded API responses: bitcoin/bips PRs #2337 and
// #2302 (both BIP 352) with their comments, and a trimmed bitcoin/bitcoin
// #35301 (Core's silent payments PR, linked from a claim). No network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  githubCollector,
  httpGithubApi,
  watchedItems,
  type GithubApi,
  type GithubCursor,
} from '../src/collectors/github.ts';
import { detectMentions } from '../src/mentions.ts';
import type { RawItem, RawItemInput } from '../src/types.ts';

const rec = JSON.parse(readFileSync(new URL('./fixtures/github.json', import.meta.url), 'utf8'));
const CORE = 'bitcoin/bitcoin#35301';

/** Serves the recording like GitHub would: PRs newest first in pages,
 * comments by updated_at with since= (inclusive), 3 per REST page. */
function fakeApi() {
  const calls: string[] = [];
  const api: GithubApi = {
    async graphql<T>(query: string, v: Record<string, unknown>) {
      if (query.includes('pullRequests(')) {
        calls.push(`graphql prs after=${v.after}`);
        const all = [...rec.bips_prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const start = v.after ? Number(v.after) : 0;
        const nodes = all.slice(start, start + Number(v.first));
        const end = start + nodes.length;
        return {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes },
          },
        } as T;
      }
      if (query.includes(': issueOrPullRequest(number:')) {
        const nums = [...query.matchAll(/n(\d+): issueOrPullRequest/g)].map((m) => Number(m[1]));
        calls.push(`graphql titles ${nums.join(',')}`);
        const repository = Object.fromEntries(
          nums.map((n) => [`n${n}`, rec.bips_prs.find((p: { number: number }) => p.number === n) ?? null]),
        );
        return { repository } as T;
      }
      calls.push(`graphql item ${v.owner}/${v.name}#${v.number}`);
      return { repository: { issueOrPullRequest: rec.core_pr } } as T;
    },
    async rest(pathOrUrl: string) {
      calls.push(`rest ${pathOrUrl}`);
      const u = new URL(pathOrUrl, 'https://api.github.com');
      const list = u.pathname.endsWith('/issues/comments')
        ? rec.bips_comments
        : u.pathname.endsWith('/bips/pulls/comments')
          ? rec.bips_review_comments
          : rec.core_review_comments;
      const since = u.searchParams.get('since');
      const rows = list
        .filter((c: { updated_at: string }) => !since || c.updated_at >= since)
        .sort((a: { updated_at: string }, b: { updated_at: string }) => a.updated_at.localeCompare(b.updated_at));
      const page = Number(u.searchParams.get('page') ?? 0);
      const data = rows.slice(page * 3, page * 3 + 3);
      u.searchParams.set('page', String(page + 1));
      return { data, ...(rows.length > (page + 1) * 3 ? { next: u.toString() } : {}) };
    },
  };
  return { api, calls };
}

async function collect(cursor: string | null, prPage = 1) {
  const { api, calls } = fakeApi();
  const c = githubCollector({ api, watched: [CORE], prPage });
  const out: { item: RawItemInput; cursor: string }[] = [];
  for await (const x of c.fetch(cursor)) out.push(x);
  return { c, out, calls };
}

const asRaw = (item: RawItemInput): RawItem => ({
  ...item,
  id: 1,
  source: 'github',
  content_hash: 'x',
  fetched_at: new Date(),
  meta: item.meta ?? {},
});
const tags = (d: { title?: string; body_text: string; thread_title?: string }) =>
  detectMentions({ title: d.title, body: d.body_text, thread_title: d.thread_title }, { aliases: new Map() }).map(
    (m) => `${m.bip}:${m.method}`,
  );

describe('github fetch', () => {
  it('yields PRs oldest first, then comments, review comments and watched items', async () => {
    const { out, calls } = await collect(null);
    const ids = out.map((x) => x.item.external_id);
    expect(ids.slice(0, 2)).toEqual(['bitcoin/bips#2302', 'bitcoin/bips#2337']);
    expect(ids.filter((i) => i.startsWith('bitcoin/bips/comment/'))).toHaveLength(rec.bips_comments.length);
    expect(ids.filter((i) => i.startsWith('bitcoin/bips/review_comment/'))).toHaveLength(
      rec.bips_review_comments.length,
    );
    expect(ids.filter((i) => i.startsWith('bitcoin/bitcoin'))).toEqual([
      CORE,
      ...rec.core_pr.comments.nodes.map((c: { databaseId: number }) => `bitcoin/bitcoin/comment/${c.databaseId}`),
      ...rec.core_review_comments.map((c: { id: number }) => `bitcoin/bitcoin/review_comment/${c.id}`),
    ]);
    // One GraphQL page per PR here (prPage = 1), REST pages followed via Link.
    expect(calls.filter((c) => c.startsWith('graphql prs'))).toHaveLength(2);
    expect(calls.some((c) => c.includes('page=1'))).toBe(true);
  });

  it('ends with a cursor holding the newest updated_at per stream', async () => {
    const { out } = await collect(null);
    const cursor: GithubCursor = JSON.parse(out.at(-1)!.cursor);
    const newest = (xs: { updated_at: string }[]) => xs.map((x) => x.updated_at).sort().at(-1);
    expect(cursor.prs).toBe('2026-10-27T02:41:59Z');
    expect(cursor.comments).toBe(newest(rec.bips_comments));
    expect(cursor.review_comments).toBe(newest(rec.bips_review_comments));
    expect(cursor.watched?.[CORE]).toBeDefined();
  });

  it('on the next run only refetches boundary items, with identical bodies', async () => {
    const first = await collect(null);
    const bodies = new Map(first.out.map((x) => [x.item.external_id, x.item.body]));
    const second = await collect(first.out.at(-1)!.cursor);
    expect(second.out.length).toBeLessThan(first.out.length);
    expect(second.out.map((x) => x.item.external_id)).not.toContain('bitcoin/bips#2302');
    // Same body means same content hash, so the runner stores nothing new.
    for (const x of second.out) expect(x.item.body).toBe(bodies.get(x.item.external_id));
    // Stops paging PRs once it passes the cursor.
    expect(second.calls.filter((c) => c.startsWith('graphql prs'))).toHaveLength(2);
  });
});

describe('github comment titles', () => {
  it('stores the same comment body whether or not its PR changed in the run', async () => {
    const first = await collect(null);
    const bodies = new Map(first.out.map((x) => [x.item.external_id, x.item.body]));
    // A cursor past every PR: the PR stream yields nothing, comments start over.
    const cursor = JSON.stringify({ prs: '2099-01-01T00:00:00Z', watched: JSON.parse(first.out.at(-1)!.cursor).watched });
    const later = await collect(cursor);
    const comments = later.out.filter((x) => x.item.external_id.startsWith('bitcoin/bips/'));
    expect(comments.length).toBe(rec.bips_comments.length + rec.bips_review_comments.length);
    for (const x of comments) expect(x.item.body).toBe(bodies.get(x.item.external_id));
    expect(later.calls.filter((c) => c.startsWith('graphql titles'))).toEqual(['graphql titles 2337']);
  });

  it('does not look up titles it already has', async () => {
    const { calls } = await collect(null);
    expect(calls.filter((c) => c.startsWith('graphql titles'))).toEqual([]);
  });
});

describe('github normalize', () => {
  it('tags a bips PR by its title and by the files it changes; reviews become documents', async () => {
    const { c, out } = await collect(null);
    const pr = out.find((x) => x.item.external_id === 'bitcoin/bips#2337')!;
    const docs = c.normalize(asRaw(pr.item));
    expect(docs[0]).toMatchObject({
      external_id: 'bitcoin/bips#2337',
      thread_key: 'bitcoin/bips#2337',
      title: 'BIP352: add taproot key-path spend with annex vector',
      url: 'https://github.com/bitcoin/bips/pull/2337',
    });
    expect(docs[0].body_text).toContain(
      'Changed files:\nhttps://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki',
    );
    expect(tags(docs[0])).toEqual(['352:link', '352:number']);
    const reviews = docs.slice(1);
    expect(reviews.length).toBe(rec.bips_prs[0].reviews.nodes.filter((r: { body: string }) => r.body.trim()).length);
    for (const r of reviews) {
      expect(r.thread_title).toBe(docs[0].title);
      expect(tags(r)).toContain('352:thread-title');
    }
  });

  it('links an inline review comment to the file it is on', async () => {
    const { c, out } = await collect(null);
    const rc = out.find((x) => x.item.external_id.startsWith('bitcoin/bips/review_comment/'))!;
    const [doc] = c.normalize(asRaw(rc.item));
    expect(doc.body_text).toMatch(/On file: https:\/\/github\.com\/bitcoin\/bips\/blob\/[0-9a-f]{40}\/bip-0352/);
    expect(tags(doc)).toContain('352:link');
    expect(doc.thread_title).toBe('BIP352: add taproot key-path spend with annex vector');
  });

  it('keeps a watched Core PR without bips file links', async () => {
    const { c, out } = await collect(null);
    const core = out.find((x) => x.item.external_id === CORE)!;
    const [doc] = c.normalize(asRaw(core.item));
    expect(doc).toMatchObject({ title: 'Silent Payments: Implement bip352 (take 2)', thread_key: CORE });
    expect(doc.body_text).not.toContain('Changed files');
    expect(tags(doc)).toContain('352:number');
  });

  it('stores logins only', async () => {
    const { out } = await collect(null);
    for (const x of out) expect(x.item.body).not.toMatch(/"(email|name)":/);
  });
});

describe('github setup', () => {
  it('watches the PRs that claims link to outside bitcoin/bips', () => {
    // Runs on the live data, which grows: check for known entries, not the
    // whole list. Linked from a claim (CORE) or watched by a BIP record
    // (BIP 54's implementation); never bitcoin/bips itself, which is
    // collected whole.
    const items = watchedItems();
    expect(items).toEqual(expect.arrayContaining([CORE, 'bitcoin/bitcoin#35793']));
    expect(items.every((i) => /^[\w.-]+\/[\w.-]+#\d+$/.test(i) && !i.startsWith('bitcoin/bips#'))).toBe(true);
    expect(items).toEqual([...items].sort());
  });

  it('needs a token', () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      expect(() => httpGithubApi()).toThrow('GITHUB_TOKEN is not set');
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    }
  });
});
