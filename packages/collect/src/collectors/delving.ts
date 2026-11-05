import type { Collector, DocumentInput, RawItem } from '../types.ts';

/**
 * Delving Bitcoin (Discourse). Reads /posts.json, the site-wide list of
 * public posts newest first, paging back with ?before=<id> until it reaches
 * the cursor (the highest post id stored). Posts are then yielded oldest
 * first, so a run that fails part way resumes where it stopped. The first
 * run backfills the whole forum (about 180 pages).
 *
 * Each post's `raw` is its Markdown source, so no HTML is parsed. Edits to
 * old posts are not picked up; that needs a separate pass if it matters.
 */

export const DELVING_BASE = 'https://delvingbitcoin.org';
const USER_AGENT = 'bipwatch-collector/0.1 (+https://github.com/ncoelho/bipwatch)';
const REGULAR_POST = 1;

/** The fields kept from each post. Counters like reads and score are left
 * out so the stored body (and its hash) only changes when the post does. */
export interface DelvingPost {
  id: number;
  topic_id: number;
  topic_slug: string;
  topic_title: string;
  post_number: number;
  username: string;
  name?: string | null;
  created_at: string;
  updated_at?: string;
  raw: string;
  post_url?: string;
  post_type?: number;
  hidden?: boolean;
  deleted_at?: string | null;
  reply_to_post_number?: number | null;
}

const KEEP: (keyof DelvingPost)[] = [
  'id',
  'topic_id',
  'topic_slug',
  'topic_title',
  'post_number',
  'username',
  'name',
  'created_at',
  'updated_at',
  'raw',
  'post_url',
  'post_type',
  'hidden',
  'deleted_at',
  'reply_to_post_number',
];

export type GetJson = (path: string) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with a polite delay and backoff on 429 / 5xx. */
export function httpGetJson(base = DELVING_BASE, delayMs = 300): GetJson {
  return async (path) => {
    for (let attempt = 0; ; attempt++) {
      await sleep(delayMs);
      const res = await fetch(base + path, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (res.ok) return res.json();
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= 4) throw new Error(`GET ${path}: HTTP ${res.status}`);
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
      await sleep(Math.min(wait, 120) * 1000);
    }
  };
}

/** Drops [quote=...]...[/quote] blocks (nested too): quoted text is someone
 * else's words and should not count as this post mentioning a BIP. */
export function stripQuotes(markdown: string): string {
  let text = markdown;
  for (;;) {
    const next = text.replace(/\[quote(?:=[^\]]*)?\](?:(?!\[quote)[\s\S])*?\[\/quote\]\n?/gi, '');
    if (next === text) return text.trim();
    text = next;
  }
}

export function postUrl(p: DelvingPost, base = DELVING_BASE): string {
  return base + (p.post_url ?? `/t/${p.topic_slug}/${p.topic_id}/${p.post_number}`);
}

export function delvingCollector(opts: { get?: GetJson; base?: string } = {}): Collector {
  const base = opts.base ?? DELVING_BASE;
  const get = opts.get ?? httpGetJson(base);

  return {
    source: 'delving',

    async *fetch(cursor) {
      const since = cursor ? Number(cursor) : 0;
      const found = new Map<number, DelvingPost>();
      let before: number | undefined;

      for (;;) {
        const page = (await get(before ? `/posts.json?before=${before}` : '/posts.json')) as {
          latest_posts?: DelvingPost[];
        };
        const posts = page.latest_posts ?? [];
        if (!posts.length) break;
        for (const p of posts) if (p.id > since) found.set(p.id, p);
        const lowest = Math.min(...posts.map((p) => p.id));
        if (lowest <= since + 1) break;
        if (before !== undefined && lowest >= before) break; // no progress; stop
        before = lowest;
      }

      for (const p of [...found.values()].sort((a, b) => a.id - b.id)) {
        if (p.post_type !== undefined && p.post_type !== REGULAR_POST) continue;
        if (p.hidden || p.deleted_at || !p.raw?.trim()) continue;
        const kept = Object.fromEntries(KEEP.filter((k) => k in p).map((k) => [k, p[k]]));
        yield {
          item: {
            external_id: String(p.id),
            url: postUrl(p, base),
            content_type: 'application/json',
            body: JSON.stringify(kept),
            meta: { topic_id: p.topic_id, post_number: p.post_number },
          },
          cursor: String(p.id),
        };
      }
    },

    normalize(raw: RawItem): DocumentInput[] {
      const p = JSON.parse(raw.body) as DelvingPost;
      return [
        {
          external_id: String(p.id),
          thread_key: String(p.topic_id),
          thread_title: p.topic_title,
          // Discourse keeps the title on the topic; only the opener carries it.
          title: p.post_number === 1 ? p.topic_title : undefined,
          author: p.username,
          posted_at: new Date(p.created_at),
          body_text: stripQuotes(p.raw),
          url: raw.url ?? postUrl(p, base),
        },
      ];
    },
  };
}
