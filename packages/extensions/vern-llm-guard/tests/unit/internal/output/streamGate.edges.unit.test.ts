import { describe, expect, it } from 'vitest';

import { patterns, type Check, type Detector } from '../../../../src/index.js';
import { tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { block, deltas, key, run, setup, source } from './gateHelpers.js';

describe('gateStream, redactions and tokens at the edges', () => {
  it('restores a token that arrives in pieces', async () => {
    const s = setup({ checks: [block('zzz')], stream: { holdChars: 32 } });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const text = `Please write to ${token} soon. ${'More words here. '.repeat(6)}`;
    const parts = text.match(/.{1,5}/g)!;
    const { drain } = run(s, source(deltas(...parts)));

    const { text: out } = await drain();

    expect(out).toContain('write to jane@acme.com soon.');
    expect(out).not.toContain('redacted.invalid');
  });

  it('masks by the label of the check when a finding has none', async () => {
    const plain: Detector = (segments) => {
      const at = segments[0]!.text.indexOf('hunter2');
      return at === -1 ? [] : [{ segment: 0, start: at, end: at + 7 }];
    };
    const s = setup({
      checks: [{ id: 'p', label: 'pw', detect: plain, action: 'redact', on: 'output' }],
    });
    const { drain } = run(s, source(deltas('the hunter2 is here')));
    expect((await drain()).text).toBe('the [PW] is here');
  });

  it('waits for a slow check when only slow checks are left to run', async () => {
    const slow: Detector = async (segments) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return segments.flatMap((segment, index) =>
        segment.text.includes('bad') ? [{ segment: index }] : [],
      );
    };
    const s = setup({
      checks: [{ id: 's', detect: slow, action: 'block', on: 'output', timeoutMs: 1000 }],
      stream: { holdChars: 32, windowChars: 1000 },
    });
    const parts = [
      'one two three four five six seven eight ',
      'nine ten eleven twelve ',
      'thirteen fourteen ',
    ];
    const { drain } = run(s, source(deltas(...parts)));

    const { text, error } = await drain();

    expect(error).toBeUndefined();
    expect(text).toBe(parts.join(''));
  });
});

describe('gateStream, random chunking', () => {
  const email: Check = { id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' };

  /** A small seeded generator, so a failure can be replayed. */
  function random(seed: number) {
    let state = seed;
    return (max: number) => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return Math.floor((state / 4294967296) * max);
    };
  }

  const words = ['alpha', 'beta', '你好世界', 'gamma,', '😀😀', 'delta.', 'ok'];

  it.each(['checked', 'immediate'] as const)(
    'gives the same text however it is cut, in %s mode, apart from late redactions',
    async (release) => {
      for (let seed = 1; seed <= 150; seed++) {
        const next = random(seed);
        const s = setup({ checks: [email], stream: { holdChars: 32, release, windowChars: 40 } });
        const token = tokenFor(s.tokens, key, 'phone', '+47 123 45 678');
        const pieces: string[] = [];
        const expected: string[] = [];
        for (let index = 0; index < 40; index++) {
          const roll = next(10);
          if (roll === 0) {
            pieces.push('bob@other.com');
            expected.push('[EMAIL]');
          } else if (roll === 1) {
            pieces.push(token);
            expected.push('+47 123 45 678');
          } else {
            const word = words[next(words.length)]!;
            pieces.push(word);
            expected.push(word);
          }
        }
        const text = pieces.join(' ');
        const want = expected.join(' ');
        const cuts: string[] = [];
        for (let at = 0; at < text.length;) {
          const size = 1 + next(17);
          cuts.push(text.slice(at, at + size));
          at += size;
        }
        // Cuts never split a code point, as a provider's chunks do not.
        const safe = cuts.reduce<string[]>((all, cut) => {
          const last = all[all.length - 1];
          if (last !== undefined && /[\ud800-\udbff]$/.test(last)) all[all.length - 1] = last + cut;
          else all.push(cut);
          return all;
        }, []);

        const { drain, done } = run(s, source(deltas(...safe)));
        const { text: out, error } = await drain();

        expect(error, `seed ${seed}`).toBeUndefined();
        if (release === 'checked') expect(out, `seed ${seed}`).toBe(want);
        else if (done[0]!.report.late === 0) expect(out, `seed ${seed}`).toBe(want);
        expect(out, `seed ${seed}`).not.toContain('redacted.invalid');
      }
    },
  );

  it('keeps JSON valid however it is cut', async () => {
    const card: Check = { id: 'c', detect: patterns(['card']), action: 'redact', on: 'output' };
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed);
      const s = setup({ checks: [card], stream: { holdChars: 32 } });
      const entries = Array.from({ length: 20 }, (_, index) =>
        next(2) === 0
          ? `"k${index}": 4111111111111111`
          : `"k${index}": "paid 4111 1111 1111 1111 ok"`,
      );
      const text = `{${entries.join(', ')}}`;
      const cuts: string[] = [];
      for (let at = 0; at < text.length;) {
        const size = 1 + next(23);
        cuts.push(text.slice(at, at + size));
        at += size;
      }

      const { drain } = run(s, source(deltas(...cuts)), true);
      const { text: out } = await drain();

      expect(() => JSON.parse(out), `seed ${seed}`).not.toThrow();
    }
  });
});

describe('gateStream, the last steps', () => {
  it('holds back a long run that could still turn out to be a token', async () => {
    const s = setup({ checks: [block('zzz')], stream: { holdChars: 32 } });
    const run64 = `x${'ab'.repeat(100)}`;
    const { drain } = run(s, source(deltas(...(run64.match(/.{1,20}/g) ?? []))));

    const { text, seen } = await drain();

    expect(text).toBe(run64);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('refuses at the end when a slow check only finds it in the last text', async () => {
    const slow: Detector = async (segments) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return segments.flatMap((segment, index) =>
        segment.text.includes('bad') ? [{ segment: index }] : [],
      );
    };
    const s = setup({
      checks: [{ id: 's', detect: slow, action: 'block', on: 'output', timeoutMs: 1000 }],
    });
    const { drain } = run(s, source(deltas('fine ', 'bad')));

    expect((await drain()).error).toMatchObject({ code: 'content_blocked' });
  });

  it('refuses when the whole answer cannot be read and the guard fails closed', async () => {
    const picky: Detector = (segments) => {
      if (segments.some((segment) => segment.text.includes('!END'))) throw new Error('x');
      return [];
    };
    const s = setup({ checks: [{ id: 'p', detect: picky, action: 'block', on: 'output' }] });
    const { drain, done } = run(s, source(deltas('fine'), 'fine !END'));

    const { final } = await drain();

    expect(final).toMatchObject({ error: expect.objectContaining({ code: 'content_blocked' }) });
    expect(done[0]).toMatchObject({ blocked: true });
  });

  it('ignores the whole answer once the stream was refused', async () => {
    const s = setup({ checks: [block('bad')] });
    const { drain, done } = run(s, source(deltas('bad stuff'), 'bad stuff', true));

    const { final } = await drain();

    expect(final).toMatchObject({ error: expect.objectContaining({ code: 'content_blocked' }) });
    expect(done).toHaveLength(1);
  });

  it('applies a redaction a slow check found, while the text is trimmed', async () => {
    const slowEmail: Detector = async (segments, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return signal.aborted
        ? []
        : segments.flatMap((segment, index) =>
            [...segment.text.matchAll(/[\w.]+@[\w.]+\.com/g)].map((match) => ({
              segment: index,
              start: match.index,
              end: match.index + match[0].length,
            })),
          );
    };
    const s = setup({
      checks: [{ id: 'e', detect: slowEmail, action: 'redact', on: 'output', timeoutMs: 1000 }],
      stream: { holdChars: 32, windowChars: 40 },
    });
    const text = `Mail bob@other.com now. ${'Some more text goes here. '.repeat(20)}`;
    const { drain } = run(s, source(deltas(...(text.match(/.{1,9}/g) ?? []))));

    const { text: out } = await drain();

    expect(out).toContain('Mail [E] now.');
    expect(out).not.toContain('bob@other.com');
  });
});

describe('gateStream, more edges', () => {
  it('keeps back a long run of hex that may still be a token, even without whitespace', async () => {
    const s = setup({ checks: [block('zzz')], stream: { holdChars: 32 } });
    const run64 = `x${'ab'.repeat(31)}a`;
    const { drain, done } = run(s, source(deltas(run64, 'b'.repeat(140))));

    const { text } = await drain();

    expect(text).toBe(run64 + 'b'.repeat(140));
    expect(done[0]!.blocked).toBe(false);
  });

  it('does not read the whole answer once the stream was refused', async () => {
    const s = setup({ checks: [block('bad')] });
    const inner = source(deltas('bad stuff'));
    const later = new Promise<unknown>((resolve) => setTimeout(() => resolve('bad stuff'), 20));
    const { drain, done } = run(s, { chunks: inner.chunks, finalResult: later } as never);

    const { final } = await drain();
    await later;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(final).toMatchObject({ error: expect.objectContaining({ code: 'content_blocked' }) });
    expect(done).toHaveLength(1);
    expect(done[0]!.blocked).toBe(true);
  });

  it('keeps a pending redaction when a later value is turned into a token after it', async () => {
    const slowEmail: Detector = async (segments) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return segments.flatMap((segment, index) =>
        [...segment.text.matchAll(/bob@other\.com/g)].map((match) => ({
          segment: index,
          start: match.index,
          end: match.index + match[0].length,
        })),
      );
    };
    const s = setup({
      checks: [{ id: 'e', detect: slowEmail, action: 'redact', on: 'output', timeoutMs: 1000 }],
    });
    tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const { drain } = run(s, source(deltas('Mail bob@other.com now. And jane@ac', 'me.com ok')));

    const { text } = await drain();

    expect(text).toBe('Mail [E] now. And jane@acme.com ok');
  });
});
