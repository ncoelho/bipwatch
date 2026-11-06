import { git, parseHeader, showFile } from '@bipwatch/collect';
import type { BipRecord } from '@bipwatch/data';

/**
 * The spec version in force at a given time, from the bitcoin/bips history:
 * the Version header at the last commit on master that touched the spec file
 * before that time. 0.0.0 when there was no spec file yet, or its header had
 * no Version (BIP 3 introduced versions; older drafts lack one).
 */
export const NO_VERSION = '0.0.0';

export async function specVersionTimeline(
  bipsDir: string,
  bip: BipRecord,
  ref = 'origin/master',
): Promise<{ at: number; version: string }[]> {
  const out = await git(bipsDir, 'log', '--reverse', '--format=%H %cI', ref, '--', bip.spec.path);
  const timeline: { at: number; version: string }[] = [];
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
  return timeline;
}

/** Looks up a date in a timeline built by specVersionTimeline. */
export function versionAt(timeline: { at: number; version: string }[], date: Date | null): string {
  if (!date) return timeline.at(-1)?.version ?? NO_VERSION;
  let version = NO_VERSION;
  for (const t of timeline) {
    if (t.at > date.getTime()) break;
    version = t.version;
  }
  return /^\d+\.\d+\.\d+$/.test(version) ? version : NO_VERSION;
}
