import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { patterns } from '../../../../src/index.js';
import {
  createTokenMap,
  restoreTokens,
  tokenFor,
  tokenizeKnown,
  tokenRanges,
} from '../../../../src/internal/tokens/tokens.js';

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);

describe('tokenFor', () => {
  it('gives the same value the same token, in a call and in another', () => {
    const one = tokenFor(createTokenMap(), key, 'phone', '+47 912 34 567');
    const again = tokenFor(createTokenMap(), key, 'phone', '+47 912 34 567');
    expect(again).toBe(one);

    const map = createTokenMap();
    expect(tokenFor(map, key, 'phone', '+47 912 34 567')).toBe(one);
    expect(tokenFor(map, key, 'phone', '+47 912 34 567')).toBe(one);
    expect(map.entries.size).toBe(1);
  });

  it('gives different values, labels and keys different tokens', () => {
    const map = createTokenMap();
    const tokens = new Set([
      tokenFor(map, key, 'phone', '111'),
      tokenFor(map, key, 'phone', '222'),
      tokenFor(map, key, 'card', '111'),
      tokenFor(createTokenMap(), otherKey, 'phone', '111'),
    ]);
    expect(tokens.size).toBe(4);
  });

  it('keeps an email the shape of an address on a domain that is never real', () => {
    const token = tokenFor(createTokenMap(), key, 'email', 'jane@acme.com');

    expect(token).toMatch(/^x[0-9a-f]{6}@redacted\.invalid$/);
    expect(token).not.toContain('jane');
    // What a schema validator expects of an address.
    expect(token).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/);
    // And a detector finds it, which is why the output gate skips tokens.
    expect(
      (
        patterns(['email'])(
          [{ text: token, source: 'output' }],
          new AbortController().signal,
        ) as unknown[]
      ).length,
    ).toBe(1);
  });

  it('writes any other kind as a bracketed label and a short hash', () => {
    const map = createTokenMap();
    expect(tokenFor(map, key, 'phone', '+47 912 34 567')).toMatch(/^\[PHONE_[0-9a-f]{4}\]$/);
    expect(tokenFor(map, key, 'my kind', 'x')).toMatch(/^\[MY_KIND_[0-9a-f]{4}\]$/);
  });

  it('does not reveal the value, and cannot be guessed without the key', () => {
    const token = tokenFor(createTokenMap(), key, 'card', '4111 1111 1111 1111');
    expect(token).not.toContain('4111');
    expect(tokenFor(createTokenMap(), otherKey, 'card', '4111 1111 1111 1111')).not.toBe(token);
  });

  it.each([
    ['an email', 'email', 'x', 6],
    ['another kind', 'phone', '[PHONE_', 4],
  ])('lengthens the hash when two values collide in %s', (_name, label, _prefix, base) => {
    const first = tokenFor(createTokenMap(), key, label, 'A');
    const map = createTokenMap();
    // Another value already holds the short token.
    map.entries.set(first.toLowerCase(), { value: 'B' });

    const second = tokenFor(map, key, label, 'A');

    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(first.length);
    const hex = (token: string) => /([0-9a-f]+)(?=@|\])/.exec(token)![1]!;
    expect(hex(second).startsWith(hex(first))).toBe(true);
    expect(hex(second)).toHaveLength(base + 2);
    expect(restoreTokens(second, map).text).toBe('A');
    expect(restoreTokens(first, map).text).toBe('B');
  });
});

describe('a token that collides at every shorter length', () => {
  it('ends with the whole hash', () => {
    const hex = createHmac('sha256', key)
      .update('phone')
      .update('\u0000')
      .update('A')
      .digest('hex');
    const map = createTokenMap();
    for (let length = 4; length < 64; length += 2) {
      map.entries.set(`[phone_${hex.slice(0, length)}]`, { value: 'B' });
    }

    const token = tokenFor(map, key, 'phone', 'A');

    expect(token).toBe(`[PHONE_${hex}]`);
    expect(restoreTokens(token, map).text).toBe('A');
  });
});

describe('restoreTokens', () => {
  it('turns every token back into its value, counting them', () => {
    const map = createTokenMap();
    const email = tokenFor(map, key, 'email', 'jane@acme.com');
    const phone = tokenFor(map, key, 'phone', '+47 912 34 567');

    expect(restoreTokens(`mail ${email}, call ${phone}, again ${email}.`, map)).toEqual({
      text: 'mail jane@acme.com, call +47 912 34 567, again jane@acme.com.',
      restored: 3,
      unrestored: 0,
    });
  });

  it('ignores the case a model changed', () => {
    const map = createTokenMap();
    const email = tokenFor(map, key, 'email', 'jane@acme.com');
    const phone = tokenFor(map, key, 'phone', '123');

    const result = restoreTokens(`${email.toUpperCase()} and ${phone.toLowerCase()}`, map);

    expect(result.text).toBe('jane@acme.com and 123');
    expect(result.restored).toBe(2);
  });

  it('leaves a token it does not know as it is, and counts it', () => {
    const mine = tokenFor(createTokenMap(), key, 'email', 'jane@acme.com');
    const theirs = tokenFor(createTokenMap(), key, 'email', 'bob@other.com');
    const map = createTokenMap();
    tokenFor(map, key, 'email', 'jane@acme.com');

    expect(restoreTokens(`${mine} ${theirs} [PHONE_abcd] [not a token]`, map)).toEqual({
      text: `jane@acme.com ${theirs} [PHONE_abcd] [not a token]`,
      restored: 1,
      unrestored: 2,
    });
  });

  it('writes the mask text, not the value, for a token that must never come out', () => {
    const map = createTokenMap();
    const token = tokenFor(map, key, 'email', 'jane@acme.com', '[EMAIL]');

    expect(restoreTokens(`to ${token}`, map).text).toBe('to [EMAIL]');
  });

  it('masks when any check asks to, even if another would restore', () => {
    const map = createTokenMap();
    tokenFor(map, key, 'email', 'jane@acme.com');
    const token = tokenFor(map, key, 'email', 'jane@acme.com', '[EMAIL]');

    expect(restoreTokens(token, map).text).toBe('[EMAIL]');
  });

  it('keeps JSON valid when the value holds a quote or a newline', () => {
    const map = createTokenMap();
    const token = tokenFor(map, key, 'name', 'Jane "JJ"\nDoe');

    const inside = restoreTokens(`{"name": "${token}"}`, map, { json: true });

    expect(JSON.parse(inside.text)).toEqual({ name: 'Jane "JJ"\nDoe' });
    expect(restoreTokens(token, map).text).toBe('Jane "JJ"\nDoe');
  });

  it('does nothing to text without tokens', () => {
    expect(restoreTokens('plain text', createTokenMap())).toEqual({
      text: 'plain text',
      restored: 0,
      unrestored: 0,
    });
  });
});

describe('tokenizeKnown', () => {
  it('turns raw values into their tokens, and leaves the rest', () => {
    const map = createTokenMap();
    const token = tokenFor(map, key, 'email', 'jane@acme.com');

    expect(tokenizeKnown('write jane@acme.com or jane@acme.com.', map)).toBe(
      `write ${token} or ${token}.`,
    );
  });

  it('replaces a longer value whole before a shorter one inside it', () => {
    const map = createTokenMap();
    const short = tokenFor(map, key, 'name', 'Jane');
    const long = tokenFor(map, key, 'name', 'Jane Doe');

    expect(tokenizeKnown('Jane Doe and Jane', map)).toBe(`${long} and ${short}`);
  });

  it('treats a value as text, whatever characters it holds', () => {
    const map = createTokenMap();
    const token = tokenFor(map, key, 'code', 'a.b*(c)');

    expect(tokenizeKnown('x a.b*(c) y aXb*(c)', map)).toBe(`x ${token} y aXb*(c)`);
  });

  it('picks up a value added after it was first built', () => {
    const map = createTokenMap();
    tokenFor(map, key, 'name', 'Jane');
    tokenizeKnown('Jane', map);
    const bob = tokenFor(map, key, 'name', 'Bob');

    expect(tokenizeKnown('Bob', map)).toBe(bob);
  });

  it('is the identity with nothing to know', () => {
    expect(tokenizeKnown('anything', createTokenMap())).toBe('anything');
  });
});

describe('tokenRanges', () => {
  it('finds only this call tokens, by position', () => {
    const map = createTokenMap();
    const token = tokenFor(map, key, 'phone', '123');
    const strange = tokenFor(createTokenMap(), key, 'phone', '456');
    const text = `a ${token} b ${strange} c`;

    expect(tokenRanges(text, map)).toEqual([[2, 2 + token.length]]);
    expect(tokenRanges(text, createTokenMap())).toEqual([]);
  });
});
