import { folderFor, loadAll } from '@bipwatch/data';
import { BIPS_BRANCH, bipsRepoDir, git, updateBipsRepo } from '../bips/git.ts';
import type { Collector, DocumentInput, RawItem } from '../types.ts';

/**
 * bitcoin/bips commits that touch a BIP we hold a record for: its spec file
 * and its companion folder (test vectors, reference code). One raw item per
 * commit; the body is the commit with its diff limited to those paths.
 *
 * SPEC 6.1 says tracked BIPs. This watches every BIP under data/bips,
 * because every bip.yaml copies facts from its spec header and has to stay
 * in sync, tracked or not.
 *
 * The cursor records the last commit stored and which BIPs it covers:
 * {"sha": "...", "bips": [352, 375]}. When a BIP is added to data/, the next
 * run fetches that BIP's whole history; BIPs already covered continue from
 * the sha. A cursor that is a bare sha (from before the BIP list was kept)
 * is read as covering every BIP watched now.
 */

export interface BipsRepoCursor {
  sha: string;
  bips: number[];
}

export function parseBipsRepoCursor(cursor: string | null, watched: WatchedBip[]): BipsRepoCursor | null {
  if (!cursor) return null;
  if (cursor.trim().startsWith('{')) return JSON.parse(cursor) as BipsRepoCursor;
  return { sha: cursor, bips: watched.map((w) => w.number) };
}

const SEP = '\x1f';
const COMMIT_URL = 'https://github.com/bitcoin/bips/commit/';
const BLOB_URL = 'https://github.com/bitcoin/bips/blob/';

export interface WatchedBip {
  number: number;
  paths: string[];
}

export function watchedBips(dataDir?: string): WatchedBip[] {
  return loadAll(dataDir).map(({ bip }) => {
    const folder = `bip-${folderFor(bip.number)}`;
    // Both spellings, so a mediawiki -> markdown conversion is still seen.
    return {
      number: bip.number,
      paths: [`${folder}.mediawiki`, `${folder}.md`, `${folder}/`],
    };
  });
}

export interface CommitMeta {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  bips: number[];
}

export function bipsForFiles(files: string[], watched: WatchedBip[]): number[] {
  return watched
    .filter((w) => files.some((f) => w.paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))))
    .map((w) => w.number);
}

export function bipsRepoCollector(
  opts: { dir?: string; remote?: string; watched?: WatchedBip[]; ref?: string } = {},
): Collector {
  const dir = opts.dir ?? bipsRepoDir();
  const watched = opts.watched ?? watchedBips();
  const paths = watched.flatMap((w) => w.paths);

  return {
    source: 'bips-repo',

    async *fetch(cursorText) {
      const tip = opts.ref
        ? (await git(dir, 'rev-parse', opts.ref)).trim()
        : await updateBipsRepo(dir, opts.remote);
      const prev = parseBipsRepoCursor(cursorText, watched);
      const covered = new Set(prev?.bips ?? []);
      const fresh = watched.filter((w) => !covered.has(w.number));
      const known = watched.filter((w) => covered.has(w.number));

      // New commits for BIPs already covered, and the whole history of BIPs
      // that are new to the record (or of everything, on the first run).
      const listed = async (range: string, ws: WatchedBip[]) =>
        ws.length
          ? (await git(dir, 'log', '--format=%H', range, '--', ...ws.flatMap((w) => w.paths)))
              .split('\n')
              .filter(Boolean)
          : [];
      const fromRange = prev ? await listed(`${prev.sha}..${tip}`, known) : [];
      const fromHistory = await listed(tip, prev ? fresh : watched);
      const rangeShas = new Set(fromRange);
      const wanted = new Set([...fromRange, ...fromHistory]);
      // Oldest first, in git's own order over every watched path.
      const shas = wanted.size
        ? (await git(dir, 'log', '--reverse', '--format=%H', tip, '--', ...paths))
            .split('\n')
            .filter((sha) => wanted.has(sha))
        : [];

      const bips = watched.map((w) => w.number).sort((a, b) => a - b);
      let lastSha = prev?.sha ?? null;
      for (const sha of shas) {
        const [author, date, subject] = (
          await git(dir, 'show', '-s', `--format=%an${SEP}%aI${SEP}%s`, sha)
        )
          .trim()
          .split(SEP);
        const files = (
          await git(dir, 'show', '--format=', '--name-only', sha, '--', ...paths)
        )
          .split('\n')
          .filter(Boolean);
        // %B is the full message; the patch follows, limited to watched paths.
        // No author email: the archive stores names only.
        const body = await git(
          dir,
          'show',
          '--format=commit %H%nAuthor: %an%nDate: %aI%n%n%B',
          '--patch',
          sha,
          '--',
          ...paths,
        );
        const meta: CommitMeta = {
          sha,
          author,
          date,
          subject,
          files,
          bips: bipsForFiles(files, watched),
        };
        yield {
          item: {
            external_id: sha,
            url: COMMIT_URL + sha,
            content_type: 'text/x-git-commit',
            body,
            meta: { ...meta, branch: BIPS_BRANCH },
          },
          // History-only commits are older than the cursor sha: they do not move it.
          cursor: JSON.stringify({ sha: (lastSha = !prev || rangeShas.has(sha) ? sha : lastSha!), bips }),
        };
      }
    },

    normalize(raw: RawItem): DocumentInput[] {
      const meta = raw.meta as unknown as CommitMeta;
      const message = raw.body.split('\n').slice(4).join('\n').split(/\ndiff --git /)[0].trim();
      // Link each changed file at this commit, so mention detection tags the
      // BIPs by link without reading the spec text inside the diff.
      const links = meta.files.map((f) => `${BLOB_URL}${meta.sha}/${f}`);
      return [
        {
          external_id: meta.sha,
          thread_key: meta.bips.length ? `bip-${meta.bips[0]}` : undefined,
          author: meta.author,
          posted_at: new Date(meta.date),
          title: meta.subject,
          body_text: `${message}\n\nChanged files:\n${links.join('\n')}`,
          url: raw.url,
        },
      ];
    },
  };
}
