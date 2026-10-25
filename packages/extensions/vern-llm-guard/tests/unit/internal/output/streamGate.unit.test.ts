import { describe, expect, it, vi } from 'vitest';

import { patterns, type Check, type Detector } from '../../../../src/index.js';
import { tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { block, deltas, failingMemo, find, key, long, run, setup, source } from './gateHelpers.js';

import type { StreamChunk } from 'vern-llm';

describe('gateStream releases', () => {
  it('only up to a whitespace boundary at least holdChars behind the end', async () => {
    const s = setup({ checks: [block('zzz')], stream: { holdChars: 32 } });
    const text = `${long} ${long} ${long} tail end`;
    const { drain } = run(s, source(deltas(text.slice(0, 50), text.slice(50, 90), text.slice(90))));

    const { seen, text: out } = await drain();

    expect(out).toBe(text);
    // Each piece ends on whitespace, except the last, which is sent when the stream ends.
    const pieces = seen.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : ''));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.slice(0, -1).every((piece) => piece.endsWith(' '))).toBe(true);
  });

  it('a value split across chunks is caught, because the end is held', async () => {
    const s = setup({ checks: [block('secret-value')], stream: { holdChars: 32 } });
    const { drain } = run(s, source(deltas(`${long} ${long} secret-`, 'value and more text')));

    const { text, error } = await drain();

    expect(text).not.toContain('secret');
    expect(error).toMatchObject({ code: 'content_blocked' });
  });

  it('a block cancels the inner stream and rejects finalResult with it', async () => {
    const s = setup({ checks: [block('bad')] });
    const src = source(deltas('fine so far ', 'now bad', ' and more', ' and more'));
    const { drain, done } = run(s, src);

    const { error, final } = await drain();

    expect(error).toMatchObject({ code: 'content_blocked' });
    expect(final).toMatchObject({ error: expect.objectContaining({ code: 'content_blocked' }) });
    expect(src.state.left).toBe(true);
    expect(src.state.yielded).toBeLessThan(4);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ blocked: true });
  });
});

describe('gateStream tokens', () => {
  it('restores a token that arrives in three pieces', async () => {
    const s = setup({ checks: [block('zzz')] });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const full = `write to ${token} please`;
    const { drain } = run(s, source(deltas(full.slice(0, 14), full.slice(14, 20), full.slice(20))));

    const { text, final } = await drain();

    expect(text).toBe('write to jane@acme.com please');
    expect(final).toEqual({ value: 'write to jane@acme.com please' });
  });

  it('tokenizes a raw echo split across chunks before the checks look', async () => {
    const s = setup({ checks: [block('jane@acme.com')] });
    tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const { drain } = run(s, source(deltas('mail jane@ac', 'me.com now')));

    const { text, error } = await drain();

    // The user's own value is not what the output check is after.
    expect(error).toBeUndefined();
    expect(text).toBe('mail jane@acme.com now');
  });

  it('escapes a restored value inside JSON', async () => {
    const s = setup({ checks: [block('zzz')] });
    const token = tokenFor(s.tokens, key, 'name', 'Jane "JJ"');
    const { drain } = run(s, source(deltas(`{"name": "${token}"}`)), true);

    const { text } = await drain();

    expect(JSON.parse(text)).toEqual({ name: 'Jane "JJ"' });
  });

  it('writes the mask for a value that must not come back', async () => {
    const s = setup({ checks: [block('zzz')] });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com', '[EMAIL]');
    const { drain } = run(s, source(deltas(`to ${token}`)));

    expect((await drain()).text).toBe('to [EMAIL]');
  });
});

describe('gateStream slow checks', () => {
  it('run per window, once the first batch showed they are slow', async () => {
    const slow = vi.fn<Detector>(async (segments) =>
      find('zzz')(segments, new AbortController().signal),
    );
    const fast = vi.fn<Detector>((segments, signal) => find('zzz')(segments, signal));
    const s = setup({
      checks: [
        { id: 'slow', detect: slow, on: 'output' },
        { id: 'fast', detect: fast, on: 'output' },
      ],
      stream: { holdChars: 32, windowChars: 200 },
    });
    const parts = Array.from({ length: 10 }, (_, i) => `${'w'.repeat(30)} ${i} `);
    const { drain } = run(s, source(deltas(...parts)));

    await drain();

    expect(fast.mock.calls.length).toBeGreaterThan(slow.mock.calls.length);
    expect(slow.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('do not let text out that they have not read', async () => {
    const reads: number[] = [];
    const slow: Detector = async (segments) => {
      reads.push(segments[0]!.text.length);
      return find('zzz')(segments, new AbortController().signal);
    };
    const s = setup({
      checks: [{ id: 'slow', detect: slow, action: 'block', on: 'output' }],
      stream: { holdChars: 32, windowChars: 100 },
    });
    const parts = Array.from({ length: 6 }, (_, i) => `${'w'.repeat(40)} ${i} zzz `);
    const { drain } = run(s, source(deltas(...parts)));

    const { text, error } = await drain();

    expect(error).toMatchObject({ code: 'content_blocked' });
    expect(text).not.toContain('zzz');
  });
});

describe('gateStream release modes', () => {
  it("'immediate' sends first and checks after, 'checked' the reverse", async () => {
    const parts = deltas('some words here ', 'then the bad part ', 'and a tail');
    const checked = setup({ checks: [block('bad')], stream: { release: 'checked' } });
    const immediate = setup({ checks: [block('bad')], stream: { release: 'immediate' } });

    const a = await run(checked, source([...parts])).drain();
    const b = await run(immediate, source([...parts])).drain();

    expect(a.text).not.toContain('bad');
    expect(b.text).toContain('some words here');
    expect(b.error).toMatchObject({ code: 'content_blocked' });
  });

  it("counts a redaction that 'immediate' could not make as late", async () => {
    const s = setup({
      checks: [{ id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' }],
      stream: { release: 'immediate' },
    });
    const { drain, done } = run(s, source(deltas('write to bob@other.com now')));

    const { text } = await drain();

    expect(text).toContain('bob@other.com');
    expect(done[0]!.report.late).toBeGreaterThan(0);
  });
});

describe('gateStream and the whole answer', () => {
  it('finalResult is checked even when chunks is never read', async () => {
    const s = setup({ checks: [block('bad')] });
    const { gated, done } = run(s, source(deltas('this is bad'), 'this is bad', true));

    await expect(gated.finalResult).rejects.toMatchObject({ code: 'content_blocked' });

    expect(done[0]).toMatchObject({ blocked: true });
    expect(done[0]!.report.late).toBe(1);
  });

  it('finalResult restores values in a value that is not text', async () => {
    const s = setup({ checks: [block('zzz')] });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const { drain } = run(s, source(deltas('x'), { to: token }));

    expect((await drain()).final).toEqual({ value: { to: 'jane@acme.com' } });
  });

  it('reports the provider failing, and still reports once', async () => {
    const s = setup({ checks: [block('zzz')] });
    const failing = {
      chunks: (async function* () {
        yield* deltas('hi');
      })(),
      finalResult: Promise.reject(new Error('provider')),
    };
    const { gated, done } = run(s, failing as never);
    gated.finalResult.catch(() => {});

    await expect(gated.finalResult).rejects.toThrow('provider');
    expect(done).toHaveLength(1);
    expect(done[0]!.blocked).toBe(false);
  });
});

describe('gateStream tool calls and other chunks', () => {
  it('holds a call until a new one starts, and passes usage straight through', async () => {
    const s = setup({ checks: [block('zzz')] });
    const token = tokenFor(s.tokens, key, 'email', 'jane@acme.com');
    const usage: StreamChunk = {
      type: 'usage',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } as never,
    };
    const chunks: StreamChunk[] = [
      { type: 'tool_call_delta', index: 0, id: 'a', name: 'send', argsDelta: `{"to":"${token}` },
      usage,
      { type: 'tool_call_delta', index: 0, argsDelta: '"}' },
      { type: 'tool_call_delta', index: 1, id: 'b', name: 'other', argsDelta: '{}' },
    ];
    const { drain } = run(s, source(chunks, 'x'));

    const { seen } = await drain();

    expect(seen.map((c) => c.type)).toEqual(['usage', 'tool_call_delta', 'tool_call_delta']);
    expect(seen[1]).toMatchObject({
      index: 0,
      argsDelta: '{"to":"jane@acme.com"}',
      complete: true,
    });
    expect(seen[2]).toMatchObject({ index: 1, argsDelta: '{}', complete: true });
  });

  it('refuses a call whose arguments hold what a check blocks', async () => {
    const s = setup({ checks: [block('bad')] });
    const chunks: StreamChunk[] = [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'a',
        name: 'send',
        argsDelta: '{"x":"bad"}',
        complete: true,
      },
    ];
    const { drain } = run(s, source(chunks, 'x'));

    expect((await drain()).error).toMatchObject({ code: 'content_blocked' });
  });
});

describe('gateStream when a detector breaks', () => {
  const broken: Detector = () => {
    throw new Error('boom');
  };

  it('refuses when the guard fails closed', async () => {
    const s = setup({ checks: [block('x', { detect: broken })], onError: 'closed' });
    const { drain, done } = run(s, source(deltas('hello there')));

    const { error } = await drain();

    expect(error).toMatchObject({ code: 'content_blocked' });
    expect(done[0]!.report.errors).toEqual([
      expect.objectContaining({ check: 'block', name: 'Error' }),
    ]);
  });

  it('keeps going when the check is open, and says so', async () => {
    const s = setup({ checks: [block('x', { detect: broken, onError: 'open' })] });
    const { drain, done } = run(s, source(deltas('hello there')));

    const { text, error } = await drain();

    expect(error).toBeUndefined();
    expect(text).toBe('hello there');
    expect(done[0]!.report.errors).toHaveLength(1);
  });
});

describe('gateStream late', () => {
  it('does not count a redaction it made as late when the text is seen again as context', async () => {
    const s = setup({
      checks: [{ id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' }],
      stream: { holdChars: 32 },
    });
    const text = `Write to bob@other.com when ready. ${'More text follows here. '.repeat(12)}`;
    const { drain, done } = run(s, source(deltas(...text.match(/.{1,30}/g)!)));

    const { text: out } = await drain();

    expect(out).toContain('[EMAIL]');
    expect(out).not.toContain('bob@other.com');
    expect(done[0]!.masked).toBe(1);
    expect(done[0]!.report.late).toBe(0);
  });
});

describe('gateStream and text without whitespace', () => {
  const email = block('zzz');
  const cjk = '你好世界你好世界你好';

  it('streams it in steps, not all at the end', async () => {
    const s = setup({ checks: [email], stream: { holdChars: 32 } });
    const parts = Array.from({ length: 60 }, () => cjk);
    const src = source(deltas(...parts));
    const { drain } = run(s, src);

    const { seen, text } = await drain();

    expect(text).toBe(parts.join(''));
    expect(seen.length).toBeGreaterThan(3);
  });

  it.each([
    ['checked', 'checked'],
    ['immediate', 'immediate'],
  ] as const)('never splits a character made of two code units (%s)', async (_name, release) => {
    const s = setup({ checks: [email], stream: { holdChars: 32, release } });
    // Seven code units a piece, so most pieces end in the middle of a pair.
    const all = '😀'.repeat(300);
    const parts = all.match(/[\s\S]{1,7}/g)!;
    const { drain } = run(s, source(deltas(...parts)));

    const { seen, text } = await drain();

    expect(text).toBe(all);
    for (const chunk of seen) {
      const delta = chunk.type === 'text-delta' ? chunk.delta : '';
      const last = delta.charCodeAt(delta.length - 1);
      const first = delta.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(Buffer.from(delta, 'utf8').toString('utf8')).toBe(delta);
    }
  });
});

describe('gateStream when the guard itself fails', () => {
  const email: Check = { id: 'm', detect: patterns(['email']), action: 'redact', on: 'output' };
  const withMemo = (onError: 'open' | 'closed', after: number) => {
    const s = setup({ checks: [email], onError });
    return { ...s, deps: { ...s.deps, memo: failingMemo(after) } };
  };

  it.each([
    ['while reading text', 0],
    ['while reading the whole answer', 1],
  ])('fails closed %s', async (_name, after) => {
    const { drain, done } = run(
      withMemo('closed', after),
      source(deltas('hello there'), 'hello there, whole'),
    );

    const { error, final } = await drain();

    expect(error ?? (final as { error?: unknown }).error).toMatchObject({
      code: 'content_blocked',
    });
    expect(done).toHaveLength(1);
    expect(done[0]!.blocked).toBe(true);
  });

  it.each([
    ['while reading text', 0],
    ['while reading the whole answer', 1],
  ])(
    'fails open %s, with the answer untouched and the error counted once',
    async (_name, after) => {
      const { drain, done } = run(
        withMemo('open', after),
        source(deltas('hello ', 'there', '!'), 'hello there, whole'),
      );

      const { text, error } = await drain();

      expect(error).toBeUndefined();
      expect(text).toBe('hello there!');
      expect(done[0]!.report.errors).toEqual([{ name: 'Error' }]);
    },
  );

  it('fails closed or open for a tool call it cannot read', async () => {
    const call: StreamChunk = {
      type: 'tool_call_delta',
      index: 0,
      id: 'a',
      name: 'f',
      argsDelta: '{"x":1}',
      complete: true,
    };
    const closed = await run(withMemo('closed', 0), source([call], 'x')).drain();
    const open = await run(withMemo('open', 0), source([call], 'x')).drain();

    expect(closed.error).toMatchObject({ code: 'content_blocked' });
    expect(open.seen).toEqual([call]);
  });
});

describe('gateStream tool calls, more', () => {
  const call = (index: number, extra: Partial<StreamChunk> = {}): StreamChunk =>
    ({ type: 'tool_call_delta', index, ...extra }) as StreamChunk;

  it('joins argument pieces, and sends a call that never says it is complete when the stream ends', async () => {
    const s = setup({ checks: [block('zzz')] });
    const { drain } = run(
      s,
      source(
        [
          call(0, { id: 'a', name: 'f', argsDelta: '{"a":' }),
          call(0, { argsDelta: '1}' }),
          call(5),
        ],
        'x',
      ),
    );

    const { seen } = await drain();

    expect(seen).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'a',
        name: 'f',
        argsDelta: '{"a":1}',
        complete: true,
      },
      { type: 'tool_call_delta', index: 5, argsDelta: '', complete: true },
    ]);
  });

  it('takes the arguments of a complete chunk as they are', async () => {
    const s = setup({ checks: [block('zzz')] });
    const { drain } = run(
      s,
      source(
        [call(0, { argsDelta: '{"a":' }), call(0, { argsDelta: '{"b":2}', complete: true })],
        'x',
      ),
    );
    const { seen } = await drain();
    expect(seen).toEqual([
      { type: 'tool_call_delta', index: 0, argsDelta: '{"b":2}', complete: true },
    ]);
  });

  it.each([
    [
      'when another call starts',
      [call(0, { argsDelta: '{"x":"bad"}' }), call(1, { argsDelta: '{}' })],
    ],
    ['when the stream ends', [call(0, { argsDelta: '{"x":"bad"}' })]],
  ])('refuses a call with blocked arguments %s', async (_name, chunks) => {
    const s = setup({ checks: [block('bad')] });
    const { drain } = run(s, source(chunks, 'x'));
    expect((await drain()).error).toMatchObject({ code: 'content_blocked' });
  });
});

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
