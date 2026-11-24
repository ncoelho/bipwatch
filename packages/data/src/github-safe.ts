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

// owner/repo#123, which GitHub also turns into a cross-reference.
const SHORT_REF = /(^|[^\w`/.-])([A-Za-z0-9][\w.-]*\/[\w.-]+#\d+)(?![\w`])/g;

/**
 * Quoted or model-written text made safe to post: every @login and every
 * owner/repo#123 goes in a code span, and every link to another repository's
 * issue, pull request or commit goes through noBacklink. Quotes are where
 * these hide: a reply that links the PR it talks about would otherwise post
 * "mentioned this" there. An @ inside a URL (a mailing-list archive link,
 * say) is not a mention and is left alone.
 */
export function noMentions(text: string): string {
  return text
    .split(URL)
    .map((part, i) =>
      i % 2
        ? noBacklink(part)
        : part
            .replace(MENTION, (_, pre: string, login: string) => `${pre}\`@${login}\``)
            .replace(SHORT_REF, (_, pre: string, ref: string) => (ref.toLowerCase().startsWith('ncoelho/bipwatch#') ? `${pre}${ref}` : `${pre}\`${ref}\``)),
    )
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
