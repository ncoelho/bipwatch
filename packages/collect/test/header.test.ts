import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorName, parseHeader } from '../src/bips/header.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseHeader', () => {
  it('reads a mediawiki preamble (BIP 352)', () => {
    const h = parseHeader(fixture('bip-0352.header.mediawiki'));
    expect(h).toMatchObject({
      number: 352,
      title: 'Silent Payments',
      layer: 'Applications',
      type: 'Specification',
      status: 'Complete',
      version: '1.1.2',
      assigned: '2023-03-09',
      license: 'BSD-2-Clause',
      authors: ['josibake', 'Ruben Somsen', 'Sebastian Falbesoner'],
      requires: [340, 341, 350],
    });
    expect(h.discussion).toHaveLength(4);
    expect(h.discussion![0]).toEqual({
      date: '2022-03-13',
      url: 'https://gist.github.com/RubenSomsen/c43b79517e7cb701ebf77eec6dbb46b8',
      title: 'Original proposal',
    });
    expect(h.discussion![3].title).toBe(
      'BIP-352 Silent Payments addresses should have an expiration time',
    );
  });

  it('reads a markdown preamble (BIP 54)', () => {
    expect(parseHeader(fixture('bip-0054.header.md'))).toMatchObject({
      number: 54,
      title: 'Consensus Cleanup',
      layer: 'Consensus (soft fork)',
      status: 'Complete',
      authors: ['Antoine Poinsot', 'Matt Corallo'],
      license: 'CC0-1.0',
    });
  });

  it('keeps unmapped fields in raw and reads a bare discussion URL (BIP 375)', () => {
    const h = parseHeader(fixture('bip-0375.header.mediawiki'));
    expect(h.raw.Deputies).toEqual(['macgyver <macgyver.sp@pm.me>']);
    expect(h.authors).toEqual(['Andrew Toth', 'Ava Chow', 'josibake']);
    expect(h.discussion).toEqual([{ url: 'https://groups.google.com/g/bitcoindev/c/5G5wzqUXyk4' }]);
    expect(h.version).toBe('0.1.2');
  });

  it('handles old single-line comma-separated authors and no layer', () => {
    const h = parseHeader(`<pre>
  BIP: 9
  Title: Example
  Author: A One <a@x.org>, B Two <b@y.org>
  Status: Closed
  Type: Informational
</pre>`);
    expect(h.authors).toEqual(['A One', 'B Two']);
    expect(h.layer).toBeUndefined();
    expect(h.requires).toBeUndefined();
  });

  it('fails without a preamble', () => {
    expect(() => parseHeader('== Abstract ==')).toThrow('No BIP preamble');
  });

  it('strips emails from author names', () => {
    expect(authorName('  josibake <josibake@protonmail.com> ')).toBe('josibake');
  });
});
