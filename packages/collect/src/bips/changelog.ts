/**
 * The Changelog section of a spec, where the authors date each version.
 * Some specs keep their version only here, with no Version header.
 */
export type Timeline = { at: number; version: string }[];

const CHANGELOG_HEADING = /^(?:==\s*Change\s*log\s*==|##\s*Change\s*log)\s*$/im;
const NEXT_HEADING = /^(?:==[^=]|##\s)/m;
// "* '''1.0.1''' (2024-06-22):" (mediawiki), "* __1.0.1__ (2024-06-22):" or
// "- 0.2.0 2025-07-08" (markdown, as BIP 77 writes it).
export const CHANGELOG_ENTRY_RE = /^[*-]\s*(?:'''|__|\*\*)?v?(\d+\.\d+\.\d+)(?:'''|__|\*\*)?:?\s*\(?(\d{4}-\d{2}-\d{2})\)?/gm;

/** Version entries from a spec's changelog, oldest first; [] if it has none. */
export function changelogTimeline(text: string): Timeline {
  const parts = text.split(CHANGELOG_HEADING);
  if (parts.length < 2) return [];
  const body = parts[1].split(NEXT_HEADING)[0];
  return [...body.matchAll(CHANGELOG_ENTRY_RE)]
    .map((m) => ({ at: Date.parse(`${m[2]}T00:00:00Z`), version: m[1] }))
    .sort((a, b) => a.at - b.at);
}

/** The newest version in a spec's changelog, if it has one. */
export function latestChangelogVersion(text: string): string | undefined {
  return changelogTimeline(text).at(-1)?.version;
}

/**
 * Changelog entries with their notes: the lines under each version, as plain
 * text (list markers and wiki or markdown emphasis removed), oldest first.
 */
export function changelogEntries(text: string): { version: string; date: string; notes: string[] }[] {
  const parts = text.split(CHANGELOG_HEADING);
  if (parts.length < 2) return [];
  const body = parts[1].split(NEXT_HEADING)[0];
  const marks = [...body.matchAll(CHANGELOG_ENTRY_RE)];
  return marks
    .map((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
      const notes = body
        .slice(m.index! + m[0].length, end)
        .split('\n')
        .map((l) =>
          l
            .replace(/<ref[^>]*>(?:.*?<\/ref>)?|<ref[^>]*\/>/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/^[\s*#:-]+/, '')
            .replace(/'''|''|__|\*\*|`/g, '')
            .trim(),
        )
        .filter((l) => l.length > 2);
      return { version: m[1], date: m[2], notes };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
