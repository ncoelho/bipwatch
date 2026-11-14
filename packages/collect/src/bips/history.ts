import { CHANGELOG_ENTRY_RE } from './changelog.ts';
import { git } from './git.ts';

/**
 * A spec file's change history on the main branch, one entry per commit as
 * the branch saw it (--first-parent: a merged pull request is one change).
 * Read from one `git log -p`, so it is cheap even on a partial clone.
 *
 * Each entry says which part of the file changed: the header (the preamble
 * up to its closing ``` or </pre>), the body, and whether a changelog entry
 * was added. Statuses and versions set in the header are picked up from the
 * added header lines.
 */
export interface SpecChange {
  sha: string;
  /** YYYY-MM-DD, committer date (when it reached the branch). */
  date: string;
  /** Pull request number, from "Merge pull request #N" or a "(#N)" suffix. */
  pr?: number;
  title: string;
  header: boolean;
  body: boolean;
  changelog: boolean;
  /** Lines added or removed outside the header. */
  bodyLines: number;
  /** Status the header was set to by this change, if it set one. */
  status?: string;
  /** Version the header or changelog was set to by this change. */
  version?: string;
}

const SEP = '\u0001';

/** Line number (1-based) of the header's closing fence, or 0 if none. */
export function headerEnd(text: string): number {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => l.trim() === '<pre>' || l.trim().startsWith('```'));
  if (open < 0 || open > 3) return 0;
  const closer = lines[open].trim() === '<pre>' ? '</pre>' : '```';
  const close = lines.findIndex((l, i) => i > open && l.trim().startsWith(closer));
  return close < 0 ? 0 : close + 1;
}

/** Parses `git log -p -U0 --format=SEP%H%x1f%cI%x1f%s%x1f%b` output. */
export function parseSpecLog(out: string, headerLines: number): SpecChange[] {
  const changes: SpecChange[] = [];
  for (const chunk of out.split(SEP).slice(1)) {
    const nl = chunk.indexOf('\ndiff --git');
    const meta = nl < 0 ? chunk : chunk.slice(0, nl);
    const diff = nl < 0 ? '' : chunk.slice(nl);
    const [sha, date, subject, body = ''] = meta.split('\x1f');
    const merge = subject.match(/^Merge pull request #(\d+)/);
    const squash = subject.match(/\(#(\d+)\)\s*$/);
    const title = merge ? (body.trim().split('\n')[0] || subject) : subject.replace(/\s*\(#\d+\)\s*$/, '');
    const c: SpecChange = {
      sha,
      date: date.slice(0, 10),
      ...(merge || squash ? { pr: Number((merge ?? squash)![1]) } : {}),
      title: title.trim(),
      header: false,
      body: false,
      changelog: false,
      bodyLines: 0,
    };
    for (const h of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const oldStart = Number(h[1]);
      const newStart = Number(h[3]);
      const newLen = h[4] === undefined ? 1 : Number(h[4]);
      const first = Math.min(oldStart || newStart, newStart || oldStart);
      if (headerLines && first <= headerLines) c.header = true;
      if (!headerLines || newStart + Math.max(newLen, 1) - 1 > headerLines || oldStart > headerLines) c.body = true;
    }
    // Count changed lines per hunk, outside the header.
    let inBody = false;
    for (const line of diff.split('\n')) {
      const hh = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (hh) inBody = !headerLines || Number(hh[2]) > headerLines || Number(hh[1]) > headerLines;
      else if (inBody && /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) c.bodyLines++;
    }
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const s = line.match(/^\+\s*Status:\s*(.+?)\s*$/);
      if (s) c.status = s[1];
      const v = line.match(/^\+\s*Version:\s*(\d+\.\d+\.\d+)/);
      if (v) c.version = v[1];
      CHANGELOG_ENTRY_RE.lastIndex = 0;
      const e = CHANGELOG_ENTRY_RE.exec(line.slice(1));
      if (e) {
        c.changelog = true;
        c.version ??= e[1];
      }
    }
    changes.push(c);
  }
  // git lists newest first; reverse so a stable sort keeps same-day order.
  return changes.reverse().sort((a, b) => a.date.localeCompare(b.date));
}

/** The history of one spec file on `ref`, oldest first. */
export async function specHistory(dir: string, ref: string, path: string, currentText: string): Promise<SpecChange[]> {
  const out = await git(dir, 'log', '-p', '-U0', '--first-parent', `--format=${SEP}%H%x1f%cI%x1f%s%x1f%b`, ref, '--', path);
  return parseSpecLog(out, headerEnd(currentText));
}

/**
 * A status in BIP 3 terms. BIP 3 renamed BIP 2's statuses (bitcoin/bips did
 * so for every BIP on 2026-01-14); a rename is not a status change.
 */
export function bip3Status(s: string): string {
  const v = s.trim().toLowerCase();
  if (v === 'proposed') return 'complete';
  if (v === 'final' || v === 'active') return 'deployed';
  if (['rejected', 'withdrawn', 'replaced', 'obsolete', 'deferred'].includes(v)) return 'closed';
  return v;
}

/**
 * When the BIP took its current status: the date of the last change that
 * moved the Status header to a different value, in BIP 3 terms (a reformat or
 * a BIP 2 to BIP 3 rename does not count), else the first change.
 */
export function statusSince(history: SpecChange[]): string | undefined {
  let prev: string | undefined;
  let since = history[0]?.date;
  for (const c of history) {
    if (!c.status) continue;
    const now = bip3Status(c.status);
    if (prev !== undefined && now !== prev) since = c.date;
    prev = now;
  }
  return since;
}
