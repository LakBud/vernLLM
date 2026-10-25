import { describe, expect, it } from 'vitest';

import { tokenFor } from '../../../../src/internal/tokens/tokens.js';
import { block, key, run, setup, source } from './gateHelpers.js';

import type { StreamChunk } from 'vern-llm';

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
