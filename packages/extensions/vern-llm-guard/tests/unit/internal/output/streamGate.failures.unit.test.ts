import { describe, expect, it } from 'vitest';

import { patterns, type Check, type Detector } from '../../../../src/index.js';
import { block, deltas, failingMemo, run, setup, source } from './gateHelpers.js';

import type { StreamChunk } from 'vern-llm';

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
