/**
 * Text and links safe to put in a pull request description on GitHub, so
 * BipWatch's bots never notify or pull in people who didn't ask for it.
 *
 * - An @login in quoted text would notify that person. It goes in a code
 *   span, which GitHub doesn't treat as a mention.
 * - A link to an issue or pull request in another repository makes GitHub
 *   post "mentioned this" on it, for everyone following it to see. Those go
 *   through redirect.github.com (as Dependabot does), which still opens the
 *   page but creates no reference.
 */

const MENTION = /(^|[^\w`/@.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-]*`)/g;

const URL = /(https?:\/\/[^\s)\]>|]+)/;

/**
 * Quoted text with every @login made inert. URLs are left whole: an @ inside
 * one (a mailing-list archive link, say) is not a mention, and a code span
 * there would break the link.
 */
export function noMentions(text: string): string {
  return text
    .split(URL)
    .map((part, i) => (i % 2 ? part : part.replace(MENTION, (_, pre: string, login: string) => `${pre}\`@${login}\``)))
    .join('');
}

const ITEM = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/(\w+)(.*)$/;

/**
 * A link that opens the same page without GitHub cross-referencing it, for
 * issues, pull requests and commits outside `ownRepo`. Other URLs are left alone.
 */
export function noBacklink(url: string, ownRepo = 'ncoelho/bipwatch'): string {
  const m = url.match(ITEM);
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() === ownRepo.toLowerCase()) return url;
  return url.replace('https://github.com/', 'https://redirect.github.com/');
}
