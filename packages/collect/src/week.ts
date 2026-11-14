import type pg from 'pg';
import type { WeekData } from '@bipwatch/data';
import { git } from './bips/git.ts';

/**
 * The homepage's week (page templates spec, homepage): what changed in the
 * BIP repo and what moved in discussion in the 7 days up to `to`. Status
 * changes and commit counts come from the bitcoin/bips git history; pull
 * requests, drafts, posts and threads from the archive. Code only.
 */

const BIP_FILE = /bip-(\d{4})\.(?:mediawiki|md)/;
const DRAFT_TITLE = /\b(BIP proposal|new BIP|BIP draft|draft BIP)\b/i;
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export async function weekData(db: pg.Pool, bipsDir: string, to = new Date()): Promise<WeekData> {
  const start = new Date(to.getTime() - 7 * 86_400_000);
  const since = start.toISOString();

  // Status changes across every spec file, newest first.
  const log = await git(bipsDir, 'log', '-p', '-U0', '--first-parent', '-G^ *Status:', '-n', '60', '--format=\u0001%H %cI', 'origin/master', '--', 'bip-*.mediawiki', 'bip-*.md');
  const changes: { bip: number; status: string; date: string; sha: string }[] = [];
  for (const chunk of log.split('\u0001').slice(1)) {
    const [head] = chunk.split('\n');
    const [sha, date] = head.split(' ');
    let bip = 0;
    let added = false;
    for (const line of chunk.split('\n')) {
      const f = line.match(/^diff --git a\/(\S+)/)?.[1].match(BIP_FILE);
      if (f) {
        bip = Number(f[1]);
        added = false;
      }
      // A new spec file sets its first status; that is not a change.
      if (line.startsWith('new file mode')) added = true;
      const s = line.match(/^\+\s*Status:\s*(.+?)\s*$/);
      if (s && bip && !added) changes.push({ bip, status: s[1], date: day(date), sha });
    }
  }
  // The BIP 2 to BIP 3 rename changed every file in one commit; skip bulk changes.
  const perCommit = new Map<string, number>();
  for (const c of changes) perCommit.set(c.sha, (perCommit.get(c.sha) ?? 0) + 1);
  const real = changes.filter((c) => (perCommit.get(c.sha) ?? 0) <= 3);
  const inWeek = real.filter((c) => c.date >= day(start));
  const last = inWeek.length ? null : real[0] ? { bip: real[0].bip, status: real[0].status, date: real[0].date } : null;
  const commits = Number((await git(bipsDir, 'rev-list', '--count', '--no-merges', `--since=${since}`, 'origin/master')).trim());

  // Latest stored version of every bitcoin/bips pull request.
  const { rows: prs } = await db.query<{ b: { number: number; title: string; url: string; state: string; created_at: string; merged_at: string | null; labels: string[]; files: string[]; kind: string } }>(
    `SELECT b FROM (SELECT DISTINCT ON (external_id) body::jsonb AS b FROM raw_items
       WHERE source = 'github' AND external_id ~ '^bitcoin/bips#[0-9]+$' ORDER BY external_id, id DESC) x
      WHERE b->>'kind' = 'pr'`,
  );
  const bipsOf = (p: { title: string; files: string[] }) => [
    ...new Set([...(p.files ?? []).flatMap((f) => f.match(BIP_FILE)?.[1] ?? []).map(Number), ...[...p.title.matchAll(/BIP[ -]?0*(\d{1,4})\b/gi)].map((m) => Number(m[1]))]),
  ].sort((a, b) => a - b);
  const merged = prs
    .filter(({ b }) => b.merged_at && b.merged_at >= since)
    .map(({ b }) => ({ number: b.number, title: b.title, url: b.url, date: day(b.merged_at!), labels: b.labels ?? [], bips: bipsOf(b) }))
    .sort((x, y) => x.date.localeCompare(y.date));
  const isNew = (b: { labels: string[] }) => (b.labels ?? []).includes('New BIP');
  const newPrs = prs.filter(({ b }) => isNew(b) && b.created_at >= since).map(({ b }) => b);
  const open = prs.filter(({ b }) => b.state === 'OPEN').map(({ b }) => b);
  const ages = open.map((b) => (to.getTime() - Date.parse(b.created_at)) / 86_400_000).sort((x, y) => x - y);
  const median = ages.length ? Math.round(ages.length % 2 ? ages[(ages.length - 1) / 2] : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2) : 0;
  const opened = prs.filter(({ b }) => !isNew(b) && b.created_at >= since).map(({ b }) => b);

  // Discussion: posts in the window, by thread.
  const { rows: threads } = await db.query<{ source: string; thread_key: string; title: string | null; url: string; posts: number; last: Date; first: Date; bips: number[] }>(
    `SELECT d.source, d.thread_key,
            (SELECT t.title FROM documents t WHERE t.source = d.source AND t.thread_key = d.thread_key AND t.title IS NOT NULL ORDER BY t.posted_at NULLS LAST, t.id LIMIT 1) AS title,
            (SELECT t.url FROM documents t WHERE t.source = d.source AND t.thread_key = d.thread_key ORDER BY t.posted_at NULLS LAST, t.id LIMIT 1) AS url,
            count(*)::int AS posts, max(d.posted_at) AS last,
            (SELECT min(t.posted_at) FROM documents t WHERE t.source = d.source AND t.thread_key = d.thread_key) AS first,
            coalesce((SELECT array_agg(DISTINCT m.bip ORDER BY m.bip) FROM bip_mentions m JOIN documents t ON t.id = m.document_id
                       WHERE t.source = d.source AND t.thread_key = d.thread_key), '{}') AS bips
       FROM documents d
      WHERE d.posted_at >= $1 AND d.source IN ('delving', 'mailing-list', 'github')
      GROUP BY d.source, d.thread_key`,
    [since],
  );
  const SOURCE = { delving: 'Delving Bitcoin', 'mailing-list': 'bitcoin-dev', github: 'GitHub' } as Record<string, string>;
  const listDrafts = threads.filter((t) => t.source !== 'github' && t.first >= new Date(since) && DRAFT_TITLE.test(t.title ?? ''));
  const draftList = [
    ...newPrs.map((b) => ({ title: b.title.replace(/^(New BIP|BIP draft):\s*/i, ''), url: b.url, date: day(b.created_at), where: `bitcoin/bips #${b.number}`, closed: b.state !== 'OPEN' })),
    ...listDrafts.map((t) => ({ title: (t.title ?? '').replace(/^\[?(BIP proposal|BIP draft)\]?:?\s*/i, ''), url: t.url, date: day(t.first), where: SOURCE[t.source], closed: false })),
  ].sort((x, y) => x.date.localeCompare(y.date));
  // One draft proposed in several places is one entry, oldest venue first.
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
  const byTitle = new Map<string, (typeof draftList)[number]>();
  for (const d of draftList) {
    const k = key(d.title);
    const seen = byTitle.get(k);
    if (seen) seen.where = `${seen.where} · ${d.where}`;
    else byTitle.set(k, { ...d });
  }
  const drafts = [...byTitle.values()].sort((x, y) => y.date.localeCompare(x.date));
  // A thread is about the BIPs its title names; else the ones its posts mention.
  const titleBips = (t: string) => [...new Set([...t.matchAll(/\bBIP[ -]?0*(\d{1,4})\b/gi)].map((m) => Number(m[1])))];
  const hot = threads
    .filter((t) => t.title)
    .sort((x, y) => y.posts - x.posts || y.last.getTime() - x.last.getTime())
    .slice(0, 6)
    .map((t) => ({ title: t.title!, url: t.url, source: SOURCE[t.source], posts: t.posts, bips: titleBips(t.title!).length ? titleBips(t.title!) : t.bips }));

  const feed: WeekData['feed'] = [
    ...merged.map((m) => ({ date: m.date, type: 'merged' as const, title: m.title, url: m.url, bips: m.bips })),
    ...drafts.map((d) => ({ date: d.date, type: 'draft' as const, title: d.title, url: d.url, bips: [] })),
    ...opened.map((b) => ({ date: day(b.created_at), type: 'opened' as const, title: b.title, url: b.url, bips: bipsOf(b) })),
    ...threads.filter((t) => t.title && t.source !== 'github').map((t) => ({ date: day(t.last), type: 'discussion' as const, title: `${t.title} (${t.posts} ${t.posts === 1 ? 'post' : 'posts'})`, url: t.url, bips: t.bips })),
  ].sort((x, y) => y.date.localeCompare(x.date));

  return {
    generated_at: to.toISOString(),
    from: day(start),
    to: day(to),
    status_changes: inWeek,
    last_status_change: last,
    commits,
    merged,
    drafts,
    open_drafts: prs.filter(({ b }) => isNew(b) && b.state === 'OPEN').length,
    discussion: { posts: threads.reduce((n, t) => n + t.posts, 0), threads: threads.length },
    waiting: { open: open.length, median_days: median },
    hot,
    feed,
  };
}
