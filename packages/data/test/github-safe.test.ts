import { describe, expect, it } from 'vitest';
import { noBacklink, noMentions } from '../src/index.ts';

describe('noMentions', () => {
  it('makes @logins inert, as in the quote that pinged people', () => {
    expect(noMentions("the working group (@sipa, @real-or-random and I) agrees it's rfm."))
      .toBe("the working group (`@sipa`, `@real-or-random` and I) agrees it's rfm.");
    expect(noMentions('@harding at the start')).toBe('`@harding` at the start');
  });

  it('leaves email addresses, code spans and plain text alone', () => {
    expect(noMentions('mail me at someone@gmail.com')).toBe('mail me at someone@gmail.com');
    expect(noMentions('already `@sipa` in code')).toBe('already `@sipa` in code');
    expect(noMentions('no mentions here')).toBe('no mentions here');
    // An @ inside a URL is not a mention; the link must stay whole.
    const url = 'https://gnusha.org/pi/bitcoindev/abc=@protonmail.com/';
    expect(noMentions(`see [list](${url}) and @sipa`)).toBe(`see [list](${url}) and \`@sipa\``);
  });
});

describe('noMentions on links in quotes', () => {
  it('routes links to other repos through redirect.github.com, as in the recheck quote', () => {
    const q = 'the former was actually based on this PR, see https://github.com/bitcoin/bips/pull/2047)), it seems';
    expect(noMentions(q)).toBe('the former was actually based on this PR, see https://redirect.github.com/bitcoin/bips/pull/2047)), it seems');
    expect(noMentions('[PR](https://github.com/bitcoin/bitcoin/pull/35793#issuecomment-1)')).toBe('[PR](https://redirect.github.com/bitcoin/bitcoin/pull/35793#issuecomment-1)');
  });
  it('puts owner/repo#123 in a code span, but not this repo or files', () => {
    expect(noMentions('see bitcoin/bips#2232 and cryptoquick/bips#21.')).toBe('see `bitcoin/bips#2232` and `cryptoquick/bips#21`.');
    expect(noMentions('ncoelho/bipwatch#20 and `bitcoin/bips#1` stay')).toBe('ncoelho/bipwatch#20 and `bitcoin/bips#1` stay');
    expect(noMentions('https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki#specification')).toBe('https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki#specification');
  });
});

describe('noBacklink', () => {
  it('routes other repos’ issues, pull requests and commits through redirect.github.com', () => {
    expect(noBacklink('https://github.com/bitcoin/bips/pull/1405')).toBe('https://redirect.github.com/bitcoin/bips/pull/1405');
    expect(noBacklink('https://github.com/bitcoin/bitcoin/pull/35301#issuecomment-1')).toBe('https://redirect.github.com/bitcoin/bitcoin/pull/35301#issuecomment-1');
    expect(noBacklink('https://github.com/bitcoin/bips/commit/a0190d0')).toBe('https://redirect.github.com/bitcoin/bips/commit/a0190d0');
  });

  it('leaves this repo and non-GitHub links alone', () => {
    expect(noBacklink('https://github.com/ncoelho/bipwatch/pull/20')).toBe('https://github.com/ncoelho/bipwatch/pull/20');
    expect(noBacklink('https://delvingbitcoin.org/t/x/1')).toBe('https://delvingbitcoin.org/t/x/1');
    expect(noBacklink('https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki')).toBe('https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki');
  });
});
