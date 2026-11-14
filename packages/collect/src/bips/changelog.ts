/**
 * The Changelog section of a spec, where the authors date each version
 * ("* '''1.0.1''' (2024-06-22):" in mediawiki, "* __1.0.1__ (2024-06-22):" in
 * markdown). Some specs keep their version only here, with no Version header.
 */
export type Timeline = { at: number; version: string }[];

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

/** The newest version in a spec's changelog, if it has one. */
export function latestChangelogVersion(text: string): string | undefined {
  return changelogTimeline(text).at(-1)?.version;
}
