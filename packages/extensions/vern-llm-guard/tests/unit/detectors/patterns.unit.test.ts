import { describe, expect, it } from 'vitest';

import { keywords, patterns, type Finding, type Segment } from '../../../src/index.js';

const signal = new AbortController().signal;
const user = (text: string): Segment => ({ text, source: 'user' });

/** The matched texts of one segment, by kind. */
function found(detector: ReturnType<typeof patterns>, text: string): [string, string][] {
  const findings = detector([user(text)], signal) as Finding[];
  return findings.map((finding) => [finding.label!, text.slice(finding.start, finding.end)]);
}

describe('patterns', () => {
  describe('email', () => {
    const detect = patterns(['email']);

    it('finds an address, and only the address', () => {
      expect(found(detect, 'Write to jane.doe+x@mail.acme.co.uk, please')).toEqual([
        ['email', 'jane.doe+x@mail.acme.co.uk'],
      ]);
    });

    it('does not read a sentence ending as part of the domain', () => {
      expect(found(detect, 'it is jane@acme.com.')).toEqual([['email', 'jane@acme.com']]);
    });

    it('leaves an at sign without an address alone', () => {
      expect(found(detect, 'meet @ noon, user@, @home, a@b')).toEqual([]);
    });
  });

  describe('card', () => {
    const detect = patterns(['card']);

    it('finds a number that passes the Luhn check, with or without separators', () => {
      expect(found(detect, 'pay 4111 1111 1111 1111 now')).toEqual([
        ['card', '4111 1111 1111 1111'],
      ]);
      expect(found(detect, '4111-1111-1111-1111')).toEqual([['card', '4111-1111-1111-1111']]);
      expect(found(detect, '4111111111111111')).toEqual([['card', '4111111111111111']]);
    });

    it('leaves a number that fails it alone', () => {
      expect(found(detect, '4111 1111 1111 1112')).toEqual([]);
    });

    it('leaves a longer run of digits alone', () => {
      expect(found(detect, '4111111111111111999999')).toEqual([]);
    });
  });

  describe('iban', () => {
    const detect = patterns(['iban']);

    it('finds a valid one, spaced or not', () => {
      expect(found(detect, 'to NO93 8601 1117 947 today')).toEqual([
        ['iban', 'NO93 8601 1117 947'],
      ]);
      expect(found(detect, 'GB82WEST12345698765432')).toEqual([['iban', 'GB82WEST12345698765432']]);
      expect(found(detect, 'GB82 WEST 1234 5698 7654 32')).toHaveLength(1);
    });

    it('leaves one with a wrong check digit alone', () => {
      expect(found(detect, 'GB83 WEST 1234 5698 7654 32')).toEqual([]);
    });
  });

  describe('phone', () => {
    const detect = patterns(['phone']);

    it('finds international and local numbers', () => {
      expect(found(detect, 'call +47 912 34 567.')).toEqual([['phone', '+47 912 34 567']]);
      expect(found(detect, 'or 912 34 567')).toEqual([['phone', '912 34 567']]);
      expect(found(detect, '(415) 555-0132')).toEqual([['phone', '(415) 555-0132']]);
    });

    it('leaves dates, timestamps and bare digits alone', () => {
      expect(found(detect, 'on 2026-10-24')).toEqual([]);
      expect(found(detect, 'at 2026-10-24 10')).toEqual([]);
      expect(found(detect, '24.10.2026')).toEqual([]);
      expect(found(detect, 'order 12345678')).toEqual([]);
      expect(found(detect, 'v1.2.3.4')).toEqual([]);
    });
  });

  describe('ip', () => {
    const detect = patterns(['ip']);

    it('finds IPv4 and IPv6 addresses', () => {
      expect(found(detect, 'from 192.168.1.20 and 2001:db8::1 ok')).toEqual([
        ['ip', '192.168.1.20'],
        ['ip', '2001:db8::1'],
      ]);
    });

    it('leaves what is not an address alone', () => {
      expect(found(detect, '256.1.1.1 and 01.02.03.04 and 10:30:00 and a :: b')).toEqual([]);
    });
  });

  describe('secrets', () => {
    const detect = patterns(['secrets']);

    it.each([
      ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
      ['an Anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
      ['an OpenAI key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
      ['a GitHub token', `ghp_${'a1B2'.repeat(9)}`],
      ['a Slack token', 'xoxb-1234567890-abcdefghij'],
      ['a Stripe key', 'sk_live_abcdefghijklmnop1234'],
      ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
      [
        'a private key block',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----',
      ],
    ])('finds %s', (_name, secret) => {
      expect(found(detect, `here: ${secret} done`)).toEqual([['secrets', secret]]);
    });

    it('leaves ordinary words and short tokens alone', () => {
      expect(found(detect, 'a task-oriented sk-short and AKIA123')).toEqual([]);
    });
  });

  it('keeps the first kind when matches overlap, so a card is not also a phone number', () => {
    const detect = patterns(['phone', 'card']);
    expect(found(detect, '4111 1111 1111 1111')).toEqual([['card', '4111 1111 1111 1111']]);
  });

  it('reports findings in the order of the text, against the segment they are in', () => {
    const detect = patterns(['email', 'ip']);
    const findings = detect([user('none here'), user('a@b.co then 10.0.0.1')], signal) as Finding[];
    expect(findings).toEqual([
      { segment: 1, label: 'email', start: 0, end: 6 },
      { segment: 1, label: 'ip', start: 12, end: 20 },
    ]);
  });

  it('takes your own patterns, and finds every match even without the g flag', () => {
    const detect = patterns({ ticket: /TCK-\d+/, code: /X\d/i });
    expect(found(detect, 'TCK-1 and TCK-22, x9')).toEqual([
      ['ticket', 'TCK-1'],
      ['ticket', 'TCK-22'],
      ['code', 'x9'],
    ]);
  });

  it('is a pure function: the same text always gives the same answer', () => {
    const detect = patterns(['email', 'phone']);
    const text = 'jane@acme.com +47 912 34 567';
    const first = found(detect, text);
    expect(found(detect, text)).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('rejects a mistake when it is built, not when it runs', () => {
    expect(() => patterns([])).toThrow(/at least one kind/);
    expect(() => patterns(['passport' as 'email'])).toThrow(/unknown kind "passport"/);
    expect(() => patterns({})).toThrow(/at least one pattern/);
    expect(() => patterns({ x: 'x' as unknown as RegExp })).toThrow(/"x" must be a RegExp/);
  });

  it('reads a long text without a match in linear time', () => {
    const detect = patterns(['email', 'phone', 'card', 'iban', 'ip', 'secrets']);
    const hostile = [
      'a.'.repeat(50_000),
      '1 '.repeat(50_000),
      `${'a'.repeat(100_000)}@`,
      `${'1.'.repeat(30_000)}x`,
      `AB12${' ABCD'.repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const text of hostile) detect([user(text)], signal);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('keywords', () => {
  const run = (detect: ReturnType<typeof keywords>, text: string) =>
    (detect([user(text)], signal) as Finding[]).map((finding) =>
      text.slice(finding.start, finding.end),
    );

  it('matches whole words only, whatever the case', () => {
    const detect = keywords(['project-x', 'cat']);
    expect(run(detect, 'Project-X is a cat, not a concatenation or CATS')).toEqual([
      'Project-X',
      'cat',
    ]);
  });

  it('can be case sensitive', () => {
    expect(run(keywords(['Acme'], { caseSensitive: true }), 'Acme, acme, ACME')).toEqual(['Acme']);
  });

  it('prefers the longer phrase and escapes what it is given', () => {
    expect(run(keywords(['top', 'top secret (v2)']), 'a top secret (v2) memo, top.')).toEqual([
      'top secret (v2)',
      'top',
    ]);
  });

  it('reports the kind keyword, never the word itself', () => {
    const findings = keywords(['hunter2'])([user('my hunter2')], signal) as Finding[];
    expect(findings.map((finding) => finding.label)).toEqual(['keyword']);
  });

  it('rejects an empty list or an empty word', () => {
    expect(() => keywords([])).toThrow(/at least one word/);
    expect(() => keywords(['ok', ''])).toThrow(/non empty string/);
  });
});

describe('patterns on hostile input', () => {
  const time = (detect: ReturnType<typeof patterns>, text: string) => {
    const started = performance.now();
    const hits = detect([user(text)], signal) as Finding[];
    return { ms: performance.now() - started, hits };
  };

  it('reads a long run of JWT lookalikes in bounded time', () => {
    const { ms, hits } = time(patterns(['secrets']), 'eyJ'.repeat(30000));
    expect(hits).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it('reads repeated private key headers without a closing line in bounded time', () => {
    const header = '-----BEGIN RSA PRIVATE KEY-----\n';
    const { ms } = time(patterns(['secrets']), header.repeat(3000));
    expect(ms).toBeLessThan(500);
  });

  it('still finds a real token and a real key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk_lmn';
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(found(patterns(['secrets']), `t ${jwt} t`)).toEqual([['secrets', jwt]]);
    expect(found(patterns(['secrets']), `k ${key} k`)).toEqual([['secrets', key]]);
  });
});

describe('patterns, edges', () => {
  it('finds a card whose doubled digits carry', () => {
    expect(found(patterns(['card']), 'card 4012 8888 8888 1881.')).toEqual([
      ['card', '4012 8888 8888 1881'],
    ]);
  });

  it('rejects an IBAN-like text that is too short or too long, or has a bad checksum', () => {
    const detect = patterns(['iban']);
    expect(found(detect, 'DE89 3704 0044')).toEqual([]);
    expect(found(detect, 'DE89 1111 1111 1111 1111 1111 1111 1111 123')).toEqual([]);
    expect(found(detect, 'DE89 3704 0044 0532 0130 01')).toEqual([]);
    expect(found(detect, 'DE89 3704 0044 0532 0130 00')).toEqual([
      ['iban', 'DE89 3704 0044 0532 0130 00'],
    ]);
  });

  it('leaves phone-like digits that are too few or too many alone', () => {
    const detect = patterns(['phone']);
    expect(found(detect, 'a 1------2 b')).toEqual([]);
    expect(found(detect, 'a 1234-5678-9012-3456-7 b')).toEqual([]);
  });

  it('takes your own patterns, with or without the g flag, and skips empty matches', () => {
    expect(found(patterns({ ticket: /TCK-\d+/ }), 'see TCK-12')).toEqual([['ticket', 'TCK-12']]);
    expect(found(patterns({ ticket: /TCK-\d+/g }), 'see TCK-12')).toEqual([['ticket', 'TCK-12']]);
    expect(found(patterns({ any: /x*/g }), 'axb')).toEqual([['any', 'x']]);
    expect(found(patterns({ a: /abc/, b: /bcd/ }), 'abcd')).toEqual([['a', 'abc']]);
  });

  it('rejects a bad list of kinds or patterns', () => {
    expect(() => patterns([])).toThrow(/at least one kind/);
    expect(() => patterns(['nope' as never])).toThrow(/unknown kind/);
    expect(() => patterns({})).toThrow(/at least one pattern/);
    expect(() => patterns({ a: 'x' as unknown as RegExp })).toThrow(/must be a RegExp/);
  });
});
