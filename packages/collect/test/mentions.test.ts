import { describe, expect, it } from 'vitest';
import { buildMentionContext, detectMentions, type MentionContext } from '../src/mentions.ts';

const ctx: MentionContext = {
  aliases: new Map([
    ['silent payments', 352],
    ['silent payment', 352],
  ]),
};

const bips = (text: string, c = ctx) =>
  detectMentions({ body: text }, c).map((m) => `${m.bip}:${m.method}`);

describe('number mentions', () => {
  it('reads the common spellings', () => {
    expect(bips('See BIP 352, BIP-341 and bip340. Also BIP0032.')).toEqual([
      '32:number',
      '340:number',
      '341:number',
      '352:number',
    ]);
  });

  it('ignores plurals, 5-digit numbers, zero and look-alikes', () => {
    expect(bips('BIPs 340 and 341, BIP 12345, BIP 0, BIPPY 9, rbip 3')).toEqual([]);
  });

  it('takes the first number of a range', () => {
    expect(bips('BIP 340-342 define taproot')).toEqual(['340:number']);
  });

  it('does not read numbers inside URLs', () => {
    expect(bips('https://example.com/BIP352-notes')).toEqual([]);
  });

  it('keeps one result per BIP and method with the first snippet', () => {
    const [m] = detectMentions({ body: 'first BIP 352 then BIP352 again' }, ctx);
    expect(m.snippet).toBe('first BIP 352 then BIP352 again');
    expect(detectMentions({ body: 'first BIP 352 then BIP352 again' }, ctx)).toHaveLength(1);
  });
});

describe('link mentions', () => {
  it('reads bitcoin/bips spec links as links, not numbers', () => {
    expect(
      bips('Spec: https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki#overview'),
    ).toEqual(['352:link']);
  });

  it('reads markdown specs, raw links and bips.dev / bips.xyz', () => {
    expect(
      bips(
        [
          'https://github.com/bitcoin/bips/blob/master/bip-0054.md',
          'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0353.mediawiki',
          'https://bips.dev/375/ and bips.xyz/376',
        ].join('\n'),
      ),
    ).toEqual(['54:link', '353:link', '375:link', '376:link']);
  });

  it('maps bips pull request links only when the PR is known', () => {
    const text = 'Discussed in https://github.com/bitcoin/bips/pull/1458';
    expect(bips(text)).toEqual([]);
    expect(bips(text, { ...ctx, prs: new Map([[1458, [352]]]) })).toEqual(['352:link']);
  });
});

describe('alias mentions', () => {
  it('matches whole phrases, any case', () => {
    expect(bips('Silent Payments are neat; one silent payment each')).toEqual(['352:alias']);
  });

  it('does not match inside longer words', () => {
    expect(bips('silent paymentsx, nonsilent payments, silent-payments-ish')).toEqual([]);
  });
});

describe('thread inheritance', () => {
  it('inherits mentions from the thread title', () => {
    const found = detectMentions(
      { title: 'Re: scanning cost', body: 'I measured it.', thread_title: 'BIP 352 scanning cost' },
      ctx,
    );
    expect(found.map((m) => `${m.bip}:${m.method}`)).toEqual(['352:thread-title']);
  });

  it('does not inherit when the document is the thread opener', () => {
    const found = detectMentions(
      { title: 'BIP 352 scanning cost', body: 'Opening post.', thread_title: 'BIP 352 scanning cost' },
      ctx,
    );
    expect(found.map((m) => `${m.bip}:${m.method}`)).toEqual(['352:number']);
  });
});

describe('dataset context', () => {
  it('loads aliases for tracked BIPs from data/', () => {
    const real = buildMentionContext();
    expect(real.aliases.get('silent payments')).toBe(352);
  });
});
