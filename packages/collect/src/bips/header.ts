/**
 * Reads the preamble at the top of a BIP: the `Key: value` block inside
 * <pre> (mediawiki) or a ``` fence (markdown). Continuation lines are indented
 * further and carry no key.
 */

export interface DiscussionEntry {
  date?: string;
  url: string;
  /** Header text after the URL, without a leading [tag]. */
  title?: string;
}

export interface SpecHeader {
  number: number;
  title: string;
  layer?: string;
  type: string;
  status: string;
  version?: string;
  assigned?: string;
  license?: string;
  /** Names only; emails are dropped. */
  authors: string[];
  requires?: number[];
  discussion?: DiscussionEntry[];
  /** Every field as raw lines, for anything not mapped above. */
  raw: Record<string, string[]>;
}

const BLOCK_RES = [/<pre>\s*\n([\s\S]*?)\n\s*<\/pre>/, /^```[^\n]*\n([\s\S]*?)\n```/m];
const FIELD_RE = /^\s{0,4}([A-Z][A-Za-z-]*):\s?(.*)$/;

export function extractPreamble(text: string): string | null {
  for (const re of BLOCK_RES) {
    const m = text.match(re);
    if (m && /^\s*BIP:/m.test(m[1])) return m[1];
  }
  return null;
}

export function parseFields(block: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(FIELD_RE);
    if (m) {
      current = m[1];
      fields[current] = m[2].trim() ? [m[2].trim()] : [];
    } else if (current) {
      fields[current].push(line.trim());
    }
  }
  return fields;
}

/** "Ruben Somsen <rsomsen@gmail.com>" -> "Ruben Somsen". */
export function authorName(entry: string): string {
  return entry.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Comma- or line-separated author lists. Commas inside <...> are kept. */
function splitAuthors(lines: string[]): string[] {
  return lines
    .flatMap((l) => l.split(/,(?![^<]*>)/))
    .map(authorName)
    .filter(Boolean);
}

const DISCUSSION_RE = /^(?:(\d{4}-\d{2}-\d{2}):\s*)?(https?:\/\/\S+)(?:\s+(.*))?$/;

export function parseDiscussion(lines: string[]): DiscussionEntry[] {
  const out: DiscussionEntry[] = [];
  for (const line of lines) {
    const m = line.match(DISCUSSION_RE);
    if (!m) continue;
    const title = m[3]?.replace(/^\[[^\]]*\]\s*/, '').trim();
    out.push({
      ...(m[1] ? { date: m[1] } : {}),
      url: m[2],
      ...(title ? { title } : {}),
    });
  }
  return out;
}

function one(fields: Record<string, string[]>, key: string): string | undefined {
  const v = fields[key]?.join(' ').trim();
  return v ? v : undefined;
}

export function parseHeader(text: string): SpecHeader {
  const block = extractPreamble(text);
  if (!block) throw new Error('No BIP preamble found');
  const f = parseFields(block);

  const number = Number(one(f, 'BIP'));
  const title = one(f, 'Title');
  const type = one(f, 'Type');
  const status = one(f, 'Status');
  if (!Number.isInteger(number) || !title || !type || !status) {
    throw new Error('BIP preamble is missing BIP, Title, Type or Status');
  }

  const requires = one(f, 'Requires')
    ?.split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);

  return {
    number,
    title,
    layer: one(f, 'Layer'),
    type,
    status,
    version: one(f, 'Version'),
    assigned: one(f, 'Assigned'),
    license: one(f, 'License'),
    authors: splitAuthors(f.Authors ?? f.Author ?? []),
    requires: requires?.length ? requires : undefined,
    discussion: f.Discussion ? parseDiscussion(f.Discussion) : undefined,
    raw: f,
  };
}
