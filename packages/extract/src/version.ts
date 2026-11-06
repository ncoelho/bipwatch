import { git, parseHeader, showFile } from '@bipwatch/collect';
import type { BipRecord } from '@bipwatch/data';

/**
 * The spec version in force at a given time.
 *
 * Preferred source: the Changelog section of the spec at `ref`, where the
 * authors date each version ("* '''1.0.1''' (2024-06-22):" in mediawiki,
 * "* __1.0.1__ (2024-06-22):" in markdown). BIP 3 added the Version header
 * later (BIP 352 got one only in 2026, starting at 1.0.2), so the changelog
 * also covers the years before the header existed.
 *
 * Fallback, for specs without a changelog: the Version header at the last
 * commit on master that touched the spec before that time.
 *
 * 0.0.0 means no version yet: before the first changelog entry, or no
 * changelog and no header.
 */
export const NO_VERSION = '0.0.0';

type Timeline = { at: number; version: string }[];

const CHANGELOG_HEADING = /^(?:==\s*Change\s*log\s*==|##\s*Change\s*log)\s*$/im;
const NEXT_HEADING = /^(?:==[^=]|##\s)/m;
const CHANGELOG_ENTRY = /^\*\s*(?:'''|__)(\d+\.\d+\.\d+)(?:'''|__)\s*\((\d{4}-\d{2}-\d{2})\)/gm;

/** Version entries from a spec's changelog, oldest first; [] if it has none. */
export function changelogTimeline(text: string): Timeline {
  const parts = text.split(CHANGELOG_HEADING);
  if (parts.length < 2) return [];
  const body = parts[1].split(NEXT_HEADING)[0];
  return [...body.matchAll(CHANGELOG_ENTRY)]
    .map((m) => ({ at: Date.parse(`${m[2]}T00:00:00Z`), version: m[1] }))
    .sort((a, b) => a.at - b.at);
}

export async function specVersionTimeline(bipsDir: string, bip: BipRecord, ref = 'origin/master'): Promise<Timeline> {
  const latest = await showFile(bipsDir, ref, bip.spec.path);
  const fromChangelog = latest ? changelogTimeline(latest) : [];
  if (fromChangelog.length) return fromChangelog;

  const out = await git(bipsDir, 'log', '--reverse', '--format=%H %cI', ref, '--', bip.spec.path);
  const timeline: Timeline = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, date] = line.split(' ');
    const text = await showFile(bipsDir, sha, bip.spec.path);
    let version = NO_VERSION;
    if (text) {
      try {
        version = parseHeader(text).version ?? NO_VERSION;
      } catch {
        // A commit with a malformed header keeps the default.
      }
    }
    timeline.push({ at: Date.parse(date), version });
  }
  // Merged branches can list commits out of date order.
  return timeline.sort((a, b) => a.at - b.at);
}

/** Looks up a date in a timeline built by specVersionTimeline. */
export function versionAt(timeline: Timeline, date: Date | null): string {
  if (!date) return timeline.at(-1)?.version ?? NO_VERSION;
  let version = NO_VERSION;
  for (const t of timeline) {
    if (t.at > date.getTime()) break;
    version = t.version;
  }
  return /^\d+\.\d+\.\d+$/.test(version) ? version : NO_VERSION;
}
