import { describe, expect, it, vi } from 'vitest';

import { patterns, type Detector } from '../../../../src/index.js';
import { tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { block, deltas, find, key, long, run, setup, source } from './gateHelpers.js';

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

describe('gateStream and the memo', () => {
  it('reads it for every chunk but only the whole answer is written to it', async () => {
    const base = setup({ checks: [block('zzz')], stream: { holdChars: 32 } });
    const sets: string[] = [];
    const memo = {
      get: () => undefined,
      set: (key: string) => void sets.push(key),
      size: 0,
    } as never;
    const s = { ...base, deps: { ...base.deps, memo } };
    const { drain } = run(s, source(deltas(`${long} one `, `${long} two `, `${long} three end`)));

    await drain();

    expect(sets.length).toBeLessThanOrEqual(1);
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
