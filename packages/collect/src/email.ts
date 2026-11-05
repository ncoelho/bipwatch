import PostalMime from 'postal-mime';

/** One list message, reduced to what the archive keeps. No addresses. */
export interface ListMessage {
  message_id: string;
  in_reply_to?: string;
  references: string[];
  from: string | null;
  date?: string;
  subject: string;
  list?: string;
  text: string;
}

const stripAngles = (s: string) => s.trim().replace(/^<|>$/g, '');

/** All <id> tokens in a References / In-Reply-To header. */
export function messageIds(header: string | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parses an RFC 822 message. Returns null when it has no Message-ID. */
export async function parseMessage(raw: Buffer | string): Promise<ListMessage | null> {
  const email = await PostalMime.parse(raw);
  const header = (name: string) => email.headers.find((h) => h.key === name)?.value;
  const id = email.messageId ? stripAngles(email.messageId) : undefined;
  if (!id) return null;

  const inReplyTo = messageIds(email.inReplyTo ?? header('in-reply-to'))[0];
  const references = messageIds(email.references ?? header('references'));
  const listId = header('list-id');

  return {
    message_id: id,
    ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    references,
    from: email.from?.name?.trim() || null,
    ...(email.date ? { date: new Date(email.date).toISOString() } : {}),
    subject: (email.subject ?? '').replace(/\s+/g, ' ').trim(),
    ...(listId ? { list: messageIds(listId)[0] ?? listId.trim() } : {}),
    text: (email.text ?? (email.html ? htmlToText(email.html) : '')).replace(/\r\n/g, '\n'),
  };
}

/** "Re: [bitcoin-dev] Re: Fwd: Title" -> "Title". */
export function cleanSubject(subject: string): string {
  let s = subject;
  for (;;) {
    const next = s
      .replace(/^\s*\[(bitcoindev|bitcoin-dev|bitcoin-development)\]\s*/i, '')
      .replace(/^\s*(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*/i, '');
    if (next === s) return s.trim();
    s = next;
  }
}

/** The thread a message belongs to: the first id in References, else
 * In-Reply-To, else itself. */
export function threadRoot(m: ListMessage): string {
  return m.references[0] ?? m.in_reply_to ?? m.message_id;
}

const FOOTERS = [
  // Google Groups (2024 on)
  /^-- ?\nYou received this message because you are subscribed[\s\S]*$/m,
  // lists.linuxfoundation.org and sourceforge eras
  /^_{20,}\n\s*bitcoin-dev(elopment)? mailing list[\s\S]*$/im,
  /^-{30,}\n[\s\S]*lists\.sourceforge\.net[\s\S]*$/m,
];

/**
 * The author's own words: drops quoted lines ("> ..."), the attribution line
 * just before a quote ("On ..., X wrote:"), and list footers. Quoted text is
 * someone else's and should not count as this message mentioning a BIP.
 */
export function ownText(text: string): string {
  let t = text;
  for (const re of FOOTERS) t = t.replace(re, '');
  const lines = t.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    // Attribution before a quote: "... wrote:", possibly wrapped from an
    // "On ..." line onto the next one.
    const quoteFollows = (from: number) =>
      /^\s*>/.test(lines.slice(from).find((l) => l.trim() !== '') ?? '');
    if (/wrote:\s*$/i.test(line) && quoteFollows(i + 1)) continue;
    if (/^\s*On /.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? '') && quoteFollows(i + 2)) {
      i++;
      continue;
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** public-inbox URL escaping for a Message-ID (its mid_escape). */
export function escapeMid(mid: string): string {
  return [...new TextEncoder().encode(mid)]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(c) && b < 128
        ? c
        : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}
