import { loadAll } from '@bipwatch/data';
import type { Mention, MentionMethod } from './types.ts';

/** What mention detection needs to know about the dataset. */
export interface MentionContext {
  /** Alias phrase (any case) to BIP number. Tracked BIPs only. */
  aliases: Map<string, number>;
  /** bitcoin/bips pull request number to the BIPs it touches, once known. */
  prs?: Map<number, number[]>;
}

export interface MentionInput {
  title?: string;
  body: string;
  /** Title of the enclosing thread when it differs from the document's own. */
  thread_title?: string;
}

const MAX_BIP = 9999;
const SNIPPET_RADIUS = 60;

// "BIP 352", "BIP-352", "bip352", "BIP 0352". Not "BIPs 340" (plural lists
// are too loose to read without a parser) and not 5+ digit numbers.
const NUMBER_RE = /\bBIP[- ]?0*(\d{1,4})\b/gi;

// Links that name a BIP directly.
const LINK_RES: RegExp[] = [
  /github\.com\/bitcoin\/bips\/(?:blob|tree|raw|commits?|edit)\/[^\s/]+\/bip-0*(\d{1,4})(?:\.(?:mediawiki|md)|\/)/gi,
  /raw\.githubusercontent\.com\/bitcoin\/bips\/[^\s/]+\/bip-0*(\d{1,4})\.(?:mediawiki|md)/gi,
  /\bbips\.(?:dev|xyz)\/0*(\d{1,4})\b/gi,
];
const PR_RE = /github\.com\/bitcoin\/bips\/pull\/(\d+)/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;

export function buildMentionContext(dataDir?: string): MentionContext {
  const aliases = new Map<string, number>();
  for (const { bip } of loadAll(dataDir)) {
    if (!bip.bipwatch.tracked) continue;
    for (const alias of bip.bipwatch.aliases ?? []) aliases.set(alias.toLowerCase(), bip.number);
  }
  return { aliases };
}

function snippetAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (end < text.length ? '…' : '');
}

function validBip(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_BIP;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces URLs with spaces of equal length so offsets stay valid. */
function blankUrls(text: string): string {
  return text.replace(URL_RE, (m) => ' '.repeat(m.length));
}

/** Every mention in one piece of text, without the thread-title rule. */
function scan(text: string, ctx: MentionContext): Mention[] {
  const found: Mention[] = [];
  const add = (bip: number, method: MentionMethod, index: number, length: number) => {
    if (validBip(bip)) found.push({ bip, method, snippet: snippetAt(text, index, length) });
  };

  for (const re of LINK_RES) {
    for (const m of text.matchAll(re)) add(Number(m[1]), 'link', m.index!, m[0].length);
  }
  if (ctx.prs) {
    for (const m of text.matchAll(PR_RE)) {
      for (const bip of ctx.prs.get(Number(m[1])) ?? []) add(bip, 'link', m.index!, m[0].length);
    }
  }

  // Numbers are read with URLs blanked out, so "bip-0352.mediawiki" counts as
  // a link only.
  const prose = blankUrls(text);
  for (const m of prose.matchAll(NUMBER_RE)) add(Number(m[1]), 'number', m.index!, m[0].length);

  if (ctx.aliases.size) {
    const phrases = [...ctx.aliases.keys()].sort((a, b) => b.length - a.length);
    const aliasRe = new RegExp(`(?<![\\w-])(?:${phrases.map(escapeRe).join('|')})(?![\\w-])`, 'gi');
    for (const m of prose.matchAll(aliasRe)) {
      add(ctx.aliases.get(m[0].toLowerCase())!, 'alias', m.index!, m[0].length);
    }
  }
  return found;
}

/**
 * Finds the BIPs a document mentions. One result per (bip, method), keeping
 * the first snippet. Mentions in the enclosing thread's title are inherited
 * with method "thread-title".
 */
export function detectMentions(input: MentionInput, ctx: MentionContext): Mention[] {
  const own = [
    ...(input.title ? scan(input.title, ctx) : []),
    ...scan(input.body, ctx),
  ];
  const inherited =
    input.thread_title && input.thread_title !== input.title
      ? scan(input.thread_title, ctx).map((m) => ({ ...m, method: 'thread-title' as const }))
      : [];

  const seen = new Map<string, Mention>();
  for (const m of [...own, ...inherited]) {
    const key = `${m.bip}:${m.method}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()].sort((a, b) => a.bip - b.bip || a.method.localeCompare(b.method));
}
