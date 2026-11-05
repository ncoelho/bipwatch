import { loadAll } from '@bipwatch/data';
import type { Collector, DocumentInput, RawItem, RawItemInput } from '../types.ts';

/**
 * GitHub discussion around the specs.
 *
 * - bitcoin/bips: every pull request (with its changed files, labels and
 *   review summaries), every conversation comment and every inline review
 *   comment. bitcoin/bips has issues turned off, so PRs are the whole story.
 * - Pull requests and issues in other repos that a claim links to
 *   (subject.url or source.url, e.g. bitcoin/bitcoin#35301): that item, its
 *   comments, reviews and inline review comments.
 *
 * PRs come from GraphQL (one query per 25 PRs with files and reviews), newest
 * first back to the cursor, then yielded oldest first. Comments come from the
 * REST list endpoints with `since=`. The cursor is a JSON object with the
 * newest updated_at seen per stream; `since` is inclusive, so the boundary
 * item is fetched again and skipped by its content hash.
 *
 * Logins are stored, not names or emails.
 */

export const BIPS_REPO = 'bitcoin/bips';
const API = 'https://api.github.com';
const USER_AGENT = 'bipwatch-collector/0.1 (+https://github.com/ncoelho/bipwatch)';
const PR_PAGE = 25;

export interface GithubApi {
  /** One REST page. `next` is the next page's URL (Link rel="next"). */
  rest(pathOrUrl: string): Promise<{ data: unknown; next?: string }>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch-based client. Waits out rate limits up to 15 minutes. */
export function httpGithubApi(token = process.env.GITHUB_TOKEN): GithubApi {
  if (!token) throw new Error('GITHUB_TOKEN is not set (locally: export GITHUB_TOKEN=$(gh auth token))');
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const limited = res.status === 429 || (res.status === 403 && remaining === 0);
      if (res.ok && !limited) {
        if (remaining === 0 && reset) await waitUntil(reset);
        return res;
      }
      if ((limited || res.status >= 500) && attempt < 4) {
        if (limited && reset) await waitUntil(reset);
        else await sleep(2 ** attempt * 2000);
        continue;
      }
      throw new Error(`GitHub ${init.method ?? 'GET'} ${url}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  async function waitUntil(resetEpoch: number) {
    const ms = resetEpoch * 1000 - Date.now() + 1000;
    if (ms > 15 * 60_000) throw new Error(`GitHub rate limit resets in ${Math.round(ms / 60000)} min`);
    if (ms > 0) await sleep(ms);
  }

  return {
    async rest(pathOrUrl) {
      const res = await call(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl);
      const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      return { data: await res.json(), ...(next ? { next } : {}) };
    },
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      const res = await call(`${API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
      return json.data as T;
    },
  };
}

// ---------- shapes we store ----------

export interface StoredReview {
  id: number;
  author: string | null;
  state: string;
  body: string;
  submitted_at: string | null;
  url: string;
}

export interface StoredPr {
  kind: 'pr' | 'issue';
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  url: string;
  labels: string[];
  files: string[];
  reviews: StoredReview[];
}

export interface StoredComment {
  kind: 'comment' | 'review_comment';
  repo: string;
  number: number;
  id: number;
  author: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  url: string;
  /** Title of the PR or issue, when known at fetch time. */
  thread_title?: string;
  /** Inline review comments: the file and commit they are on. */
  path?: string;
  commit_id?: string;
}

type Stored = StoredPr | StoredComment;
const isPr = (s: Stored): s is StoredPr => s.kind === 'pr' || s.kind === 'issue';

export interface GithubCursor {
  prs?: string;
  comments?: string;
  review_comments?: string;
  /** "owner/repo#n" -> newest updated_at seen for that item and its comments. */
  watched?: Record<string, string>;
}

// ---------- GraphQL ----------

const PR_FIELDS = `
  number title body url state createdAt updatedAt
  author { login }
  labels(first: 20) { nodes { name } }
  files(first: 100) { nodes { path } }
  reviews(first: 100) { nodes { databaseId author { login } state body submittedAt url } }`;

export const PRS_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} mergedAt }
    }
  }
}`;

export const ITEM_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest { ${PR_FIELDS} mergedAt
        comments(first: 100) { nodes { databaseId author { login } body createdAt updatedAt url } } }
      ... on Issue { number title body url state createdAt updatedAt author { login }
        labels(first: 20) { nodes { name } }
        comments(first: 100) { nodes { databaseId author { login } body createdAt updatedAt url } } }
    }
  }
}`;

interface GqlPr {
  __typename?: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  author: { login: string } | null;
  labels?: { nodes: { name: string }[] };
  files?: { nodes: { path: string }[] };
  reviews?: {
    nodes: {
      databaseId: number;
      author: { login: string } | null;
      state: string;
      body: string;
      submittedAt: string | null;
      url: string;
    }[];
  };
  comments?: {
    nodes: {
      databaseId: number;
      author: { login: string } | null;
      body: string;
      createdAt: string;
      updatedAt: string;
      url: string;
    }[];
  };
}

function toStoredPr(repo: string, n: GqlPr): StoredPr {
  return {
    kind: n.__typename === 'Issue' ? 'issue' : 'pr',
    repo,
    number: n.number,
    title: n.title,
    body: n.body ?? '',
    author: n.author?.login ?? null,
    state: n.state,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    merged_at: n.mergedAt ?? null,
    url: n.url,
    labels: n.labels?.nodes.map((l) => l.name) ?? [],
    files: n.files?.nodes.map((f) => f.path) ?? [],
    reviews: (n.reviews?.nodes ?? []).map((r) => ({
      id: r.databaseId,
      author: r.author?.login ?? null,
      state: r.state,
      body: r.body ?? '',
      submitted_at: r.submittedAt,
      url: r.url,
    })),
  };
}

// ---------- REST comments ----------

interface RestComment {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
  path?: string;
  commit_id?: string;
}

const commentNumber = (c: RestComment) =>
  Number((c.issue_url ?? c.pull_request_url ?? '').split('/').pop());

/** Fills `titles` for any PR or issue numbers it lacks, 50 per GraphQL query. */
export async function lookupTitles(
  api: GithubApi,
  owner: string,
  name: string,
  numbers: number[],
  titles: Map<number, string>,
): Promise<void> {
  const missing = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0 && !titles.has(n));
  for (let i = 0; i < missing.length; i += 50) {
    const part = missing.slice(i, i + 50);
    const fields = part
      .map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ... on PullRequest { title } ... on Issue { title } }`)
      .join('\n');
    const data = await api.graphql<{ repository: Record<string, { title: string } | null> }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner, name },
    );
    for (const n of part) {
      const t = data.repository[`n${n}`]?.title;
      if (t) titles.set(n, t);
    }
  }
}

function toStoredComment(repo: string, c: RestComment, titles: Map<number, string>): StoredComment {
  const number = commentNumber(c);
  const title = titles.get(number);
  return {
    kind: c.pull_request_url ? 'review_comment' : 'comment',
    repo,
    number,
    id: c.id,
    author: c.user?.login ?? null,
    body: c.body ?? '',
    created_at: c.created_at,
    updated_at: c.updated_at,
    url: c.html_url,
    ...(title ? { thread_title: title } : {}),
    ...(c.path ? { path: c.path, commit_id: c.commit_id } : {}),
  };
}

// ---------- what to watch outside bitcoin/bips ----------

const ITEM_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/;

/** "owner/repo#n" for every GitHub PR or issue a claim links to, outside bitcoin/bips. */
export function watchedItems(dataDir?: string): string[] {
  const out = new Set<string>();
  for (const { claims } of loadAll(dataDir)) {
    for (const c of claims) {
      const urls = [(c as { subject?: { url?: string } }).subject?.url, c.source?.url];
      for (const u of urls) {
        const m = u?.match(ITEM_URL_RE);
        if (m && `${m[1]}/${m[2]}` !== BIPS_REPO) out.add(`${m[1]}/${m[2]}#${m[3]}`);
      }
    }
  }
  return [...out].sort();
}

// ---------- collector ----------

const latest = (a: string | undefined, b: string) => (!a || b > a ? b : a);

function item(s: Stored): RawItemInput {
  const id = isPr(s) ? `${s.repo}#${s.number}` : `${s.repo}/${s.kind}/${s.id}`;
  return {
    external_id: id,
    url: s.url,
    content_type: 'application/json',
    body: JSON.stringify(s),
    meta: { kind: s.kind, repo: s.repo, number: s.number },
  };
}

export function githubCollector(
  opts: { api?: GithubApi; repo?: string; watched?: string[]; prPage?: number } = {},
): Collector {
  const repo = opts.repo ?? BIPS_REPO;
  const [owner, name] = repo.split('/');
  const prPage = opts.prPage ?? PR_PAGE;

  return {
    source: 'github',

    async *fetch(cursorText) {
      const api = opts.api ?? httpGithubApi();
      const watched = opts.watched ?? watchedItems();
      const cursor: GithubCursor = cursorText ? JSON.parse(cursorText) : {};
      const next: GithubCursor = { ...cursor, watched: { ...(cursor.watched ?? {}) } };
      const titles = new Map<number, string>();
      const emit = (s: Stored) => ({ item: item(s), cursor: JSON.stringify(next) });

      // 1. bitcoin/bips PRs, newest first back to the cursor, then oldest first.
      const prs: StoredPr[] = [];
      let after: string | null = null;
      for (;;) {
        type Page = {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GqlPr[] };
          };
        };
        const page: Page = await api.graphql<Page>(PRS_QUERY, { owner, name, first: prPage, after });
        const conn = page.repository.pullRequests;
        let reachedCursor = false;
        for (const n of conn.nodes) {
          if (cursor.prs && n.updatedAt < cursor.prs) {
            reachedCursor = true;
            break;
          }
          prs.push(toStoredPr(repo, n));
        }
        if (reachedCursor || !conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      prs.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
      for (const pr of prs) {
        titles.set(pr.number, pr.title);
        next.prs = latest(next.prs, pr.updated_at);
        yield emit(pr);
      }

      // 2. Conversation and inline review comments on bitcoin/bips.
      for (const stream of ['comments', 'review_comments'] as const) {
        const path = stream === 'comments' ? 'issues/comments' : 'pulls/comments';
        const since = cursor[stream] ? `&since=${encodeURIComponent(cursor[stream]!)}` : '';
        let url: string | undefined = `/repos/${repo}/${path}?sort=updated&direction=asc&per_page=100${since}`;
        while (url) {
          const page: { data: unknown; next?: string } = await api.rest(url);
          const comments = page.data as RestComment[];
          // A comment's stored body includes its PR title, so look up titles
          // this run has not seen; otherwise the same comment would hash
          // differently depending on which PRs changed in the run.
          await lookupTitles(api, owner, name, comments.map(commentNumber), titles);
          for (const c of comments) {
            next[stream] = latest(next[stream], c.updated_at);
            yield emit(toStoredComment(repo, c, titles));
          }
          url = page.next;
        }
      }

      // 3. PRs and issues in other repos that claims link to.
      for (const key of watched) {
        const [, wOwner, wName, wNum] = key.match(/^([^/]+)\/([^#]+)#(\d+)$/)!;
        const wRepo = `${wOwner}/${wName}`;
        const since = cursor.watched?.[key];
        type One = { repository: { issueOrPullRequest: GqlPr | null } };
        const data = await api.graphql<One>(ITEM_QUERY, { owner: wOwner, name: wName, number: Number(wNum) });
        const node = data.repository.issueOrPullRequest;
        if (!node) continue;
        const stored = toStoredPr(wRepo, node);
        const wTitles = new Map([[stored.number, stored.title]]);
        let newest = since;
        if (!since || stored.updated_at >= since) {
          newest = latest(newest, stored.updated_at);
          next.watched![key] = newest!;
          yield emit(stored);
        }
        for (const c of node.comments?.nodes ?? []) {
          if (since && c.updatedAt < since) continue;
          newest = latest(newest, c.updatedAt);
          next.watched![key] = newest!;
          yield emit({
            kind: 'comment',
            repo: wRepo,
            number: stored.number,
            id: c.databaseId,
            author: c.author?.login ?? null,
            body: c.body ?? '',
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            url: c.url,
            thread_title: stored.title,
          });
        }
        if (stored.kind === 'pr') {
          const s = since ? `&since=${encodeURIComponent(since)}` : '';
          let url: string | undefined = `/repos/${wRepo}/pulls/${wNum}/comments?per_page=100${s}`;
          while (url) {
            const page: { data: unknown; next?: string } = await api.rest(url);
            for (const c of page.data as RestComment[]) {
              newest = latest(newest, c.updated_at);
              next.watched![key] = newest!;
              yield emit(toStoredComment(wRepo, c, wTitles));
            }
            url = page.next;
          }
        }
      }
    },

    normalize(raw: RawItem): DocumentInput[] {
      const s = JSON.parse(raw.body) as Stored;
      const thread = `${s.repo}#${s.number}`;
      if (isPr(s)) {
        // Link each changed bitcoin/bips file, so mention detection tags the
        // BIPs a PR touches even when the title does not name them.
        const files = s.repo === BIPS_REPO ? s.files.map((f) => `https://github.com/${BIPS_REPO}/blob/master/${f}`) : [];
        const docs: DocumentInput[] = [
          {
            external_id: thread,
            thread_key: thread,
            title: s.title,
            author: s.author ?? undefined,
            posted_at: new Date(s.created_at),
            body_text: [s.body.trim(), files.length ? `Changed files:\n${files.join('\n')}` : '']
              .filter(Boolean)
              .join('\n\n'),
            url: s.url,
          },
        ];
        for (const r of s.reviews) {
          if (!r.body.trim()) continue;
          docs.push({
            external_id: `${thread}/review/${r.id}`,
            thread_key: thread,
            thread_title: s.title,
            author: r.author ?? undefined,
            posted_at: r.submitted_at ? new Date(r.submitted_at) : undefined,
            body_text: `${r.state}: ${r.body.trim()}`,
            url: r.url,
          });
        }
        return docs;
      }
      const file =
        s.kind === 'review_comment' && s.path && s.repo === BIPS_REPO
          ? `\n\nOn file: https://github.com/${BIPS_REPO}/blob/${s.commit_id ?? 'master'}/${s.path}`
          : '';
      return [
        {
          external_id: `${s.repo}/${s.kind}/${s.id}`,
          thread_key: thread,
          thread_title: s.thread_title,
          author: s.author ?? undefined,
          posted_at: new Date(s.created_at),
          body_text: `${s.body.trim()}${file}`,
          url: s.url,
        },
      ];
    },
  };
}
