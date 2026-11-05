// Delving collector on recorded posts (thread 877 "BIP352: PSBT support" and
// a post that quotes another). The HTTP layer is replaced; no network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { delvingCollector, stripQuotes, type DelvingPost } from '../src/collectors/delving.ts';
import { detectMentions, type MentionContext } from '../src/mentions.ts';
import type { RawItem, RawItemInput } from '../src/types.ts';

const recorded: DelvingPost[] = JSON.parse(
  readFileSync(new URL('./fixtures/delving-posts.json', import.meta.url), 'utf8'),
).latest_posts;
const ctx: MentionContext = {
  aliases: new Map([
    ['silent payments', 352],
    ['silent payment', 352],
  ]),
};

/** A fake /posts.json: newest first, `size` per page, ?before=<id>. */
function fakeApi(posts: DelvingPost[], size = 2) {
  const calls: string[] = [];
  const sorted = [...posts].sort((a, b) => b.id - a.id);
  const get = async (path: string) => {
    calls.push(path);
    const before = Number(new URL(path, 'https://x.test').searchParams.get('before') ?? Infinity);
    return { latest_posts: sorted.filter((p) => p.id < before).slice(0, size) };
  };
  return { get, calls };
}

async function collect(posts: DelvingPost[], cursor: string | null, size = 2) {
  const api = fakeApi(posts, size);
  const c = delvingCollector({ get: api.get });
  const out: { item: RawItemInput; cursor: string }[] = [];
  for await (const x of c.fetch(cursor)) out.push(x);
  return { c, out, calls: api.calls };
}

const asRaw = (item: RawItemInput): RawItem => ({
  ...item,
  id: 1,
  source: 'delving',
  content_hash: 'x',
  fetched_at: new Date(),
  meta: item.meta ?? {},
});

describe('delving fetch', () => {
  it('backfills every page on the first run and yields oldest first', async () => {
    const { out, calls } = await collect(recorded, null);
    expect(out.map((x) => x.item.external_id)).toEqual(['2441', '6631', '8985']);
    expect(out.map((x) => x.cursor)).toEqual(['2441', '6631', '8985']);
    expect(calls).toEqual(['/posts.json', '/posts.json?before=6631', '/posts.json?before=2441']);
  });

  it('stops paging once it reaches the cursor', async () => {
    const { out, calls } = await collect(recorded, '6631', 1);
    expect(out.map((x) => x.item.external_id)).toEqual(['8985']);
    expect(calls).toEqual(['/posts.json', '/posts.json?before=8985']);
  });

  it('yields nothing when there is nothing new', async () => {
    expect((await collect(recorded, '8985')).out).toEqual([]);
  });

  it('skips hidden, deleted and non-regular posts', async () => {
    const extra = [
      { ...recorded[0], id: 9001, hidden: true },
      { ...recorded[0], id: 9002, deleted_at: '2026-11-01T00:00:00Z' },
      { ...recorded[0], id: 9003, post_type: 3 },
    ];
    const { out } = await collect([...recorded, ...extra], '8985');
    expect(out).toEqual([]);
  });

  it('stores only stable fields', async () => {
    const quoting = recorded.find((p) => p.id === 8985)!;
    const noisy = { ...quoting, reads: 40, score: 9.5, yours: false } as DelvingPost;
    const { out } = await collect([noisy], null);
    expect(Object.keys(JSON.parse(out[0].item.body))).not.toContain('reads');
    expect(out[0].item.url).toBe('https://delvingbitcoin.org/t/stats-on-compact-block-reconstructions/1052/64');
  });
});

describe('delving normalize', () => {
  it('keeps the title on the opener only and tags BIP 352 thread 877', async () => {
    const { c, out } = await collect(recorded, null);
    const [opener] = c.normalize(asRaw(out[0].item));
    const [reply] = c.normalize(asRaw(out[1].item));
    expect(opener).toMatchObject({
      external_id: '2441',
      thread_key: '877',
      title: 'BIP352: PSBT support',
      author: 'josibake',
      url: 'https://delvingbitcoin.org/t/bip352-psbt-support/877/1',
    });
    expect(reply.title).toBeUndefined();
    expect(reply.thread_title).toBe('BIP352: PSBT support');

    const tags = (d: typeof opener) =>
      detectMentions({ title: d.title, body: d.body_text, thread_title: d.thread_title }, ctx).map(
        (m) => `${m.bip}:${m.method}`,
      );
    expect(tags(opener)).toEqual(expect.arrayContaining(['352:number', '352:alias']));
    expect(tags(reply)).toEqual(['352:alias', '352:thread-title']);
  });

  it('drops quoted text from the body', async () => {
    const { c, out } = await collect(recorded, null);
    const [doc] = c.normalize(asRaw(out[2].item));
    expect(doc.body_text.startsWith('Just came across')).toBe(true);
    expect(doc.body_text).not.toContain('[quote');
  });
});

describe('stripQuotes', () => {
  it('removes nested quotes and keeps the rest', () => {
    expect(
      stripQuotes('[quote="a, post:1"]outer [quote="b"]inner BIP 1[/quote] more[/quote]\nmine BIP 2'),
    ).toBe('mine BIP 2');
  });
});
