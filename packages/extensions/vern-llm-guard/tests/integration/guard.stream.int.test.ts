import { isLLMError, isStreamResult, type StreamChunk } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { keywords, patterns, type Check, type GuardResult } from '../../src/index.js';
import { createStreamClient, harness, textDeltas, tokenIn } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const, stream: true as const };
const pii: Check = { id: 'pii', detect: patterns(['email']), action: 'redact' };
const leak = (extra: Partial<Check> = {}): Check => ({
  id: 'leak',
  detect: keywords(['hunter2']),
  action: 'block',
  on: 'output',
  ...extra,
});

/** Opens a stream and reads it to the end, or to the error that stopped it. */
async function read(llm: ReturnType<typeof harness>['llm'], params: object = call) {
  const stream = (await llm.call(params as never)) as unknown as {
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<unknown>;
  };
  expect(isStreamResult(stream)).toBe(true);

  const seen: StreamChunk[] = [];
  let error: unknown;
  try {
    for await (const chunk of stream.chunks) seen.push(chunk);
  } catch (caught) {
    error = caught;
  }
  const text = seen.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('');
  const final = await stream.finalResult.then(
    (value) => ({ value }),
    (reason: unknown) => ({ error: reason }),
  );
  return { seen, text, error, final, stream };
}

function results(events: { name: string; data: unknown }[]): GuardResult[] {
  return events.filter((event) => event.name === 'guard.result').map((e) => e.data as GuardResult);
}

const code = (error: unknown) => (isLLMError(error) ? error.code : undefined);

describe('a stream with nothing to check or restore', () => {
  it('passes chunk for chunk, with no holdback', async () => {
    const { client } = createStreamClient(textDeltas('hello world', 3, 3));
    const { llm } = harness({ checks: [{ id: 'in', detect: patterns(['email']) }] }, { client });

    const { seen } = await read(llm);

    expect(seen).toEqual([
      { type: 'text-delta', delta: 'hel' },
      { type: 'text-delta', delta: 'lo ' },
      { type: 'text-delta', delta: 'world' },
    ]);
  });
});

describe('restore across chunks', () => {
  it('puts a value back that the model split over three chunks', async () => {
    const { client } = createStreamClient((params) => {
      const token = tokenIn(params);
      const text = `I will write to ${token} today and tell them about it later.`;
      return (async function* () {
        yield* textDeltas(text, 20, 8, 7);
      })();
    });
    const { llm, events } = harness({ checks: [pii] }, { client });

    const { text, final } = await read(llm, { ...call, userContent: 'mail jane@acme.com' });

    expect(text).toBe('I will write to jane@acme.com today and tell them about it later.');
    expect(final).toEqual({ value: text });
    expect(text).not.toContain('redacted.invalid');
    expect(results(events)).toHaveLength(1);
  });

  it('turns a raw echo of a value into the same restored text', async () => {
    const { client } = createStreamClient(textDeltas('reply to jane@acme.com now', 12, 4));
    const { llm } = harness({ checks: [pii] }, { client });

    const { text } = await read(llm, { ...call, userContent: 'mail jane@acme.com' });

    expect(text).toBe('reply to jane@acme.com now');
  });
});

describe('a block in a stream', () => {
  it('never shows the blocked text, cancels the provider, and fails finalResult', async () => {
    const { client, state } = createStreamClient(
      textDeltas(
        'The answer begins here and goes on. The password is hunter2 and then more words follow',
        30,
        25,
        6,
        6,
      ),
    );
    const { llm, events } = harness({ checks: [leak()] }, { client });

    const { text, error, final } = await read(llm);

    expect(text).not.toContain('hunter');
    expect(code(error)).toBe('content_blocked');
    expect(final).toMatchObject({ error: expect.objectContaining({ code: 'content_blocked' }) });
    expect(state.finished).toBe(false);
    const [result] = results(events);
    expect(results(events)).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: 'blocked',
      output: { checks: { leak: { found: 1 } } },
    });
  });

  it('catches a value split across chunks, by holding the end back', async () => {
    const { client } = createStreamClient(
      textDeltas(
        'Some long enough opening sentence before it. hunter2 is the secret, ok?',
        52,
        4,
        3,
      ),
    );
    const { llm } = harness({ checks: [leak()] }, { client });

    const { text, error } = await read(llm);

    expect(code(error)).toBe('content_blocked');
    expect(text).not.toContain('hunter');
  });

  it('with release immediate, has sent the text by the time it blocks', async () => {
    const { client } = createStreamClient(
      textDeltas('The password is hunter2 and then more words follow', 10, 12, 9),
    );
    const { llm } = harness({ checks: [leak()], stream: { release: 'immediate' } }, { client });

    const { text, error } = await read(llm);

    expect(code(error)).toBe('content_blocked');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('masking in a stream', () => {
  it('masks a value the model introduced, even split over chunks', async () => {
    const { client } = createStreamClient(
      textDeltas('Please write to bob@other.com when you are ready to go ahead.', 22, 5, 5),
    );
    const out: Check = { id: 'out', detect: patterns(['email']), action: 'redact', on: 'output' };
    const { llm } = harness({ checks: [out] }, { client });

    const { text, final } = await read(llm);

    expect(text).toBe('Please write to [EMAIL] when you are ready to go ahead.');
    expect(final).toEqual({ value: text });
  });
});

describe('slow checks', () => {
  it('run per window, and hold text back until they have read it', async () => {
    const detect = (segments: readonly { text: string }[]) =>
      Promise.resolve(
        segments.flatMap((segment, index) => {
          const at = segment.text.indexOf('hunter2');
          return at === -1 ? [] : [{ segment: index, start: at, end: at + 7 }];
        }),
      );
    const { client } = createStreamClient(
      textDeltas(`${'word '.repeat(30)}hunter2 ${'more '.repeat(30)}`, 40, 40, 40, 40, 40, 40, 40),
    );
    const { llm } = harness(
      { checks: [leak({ detect })], stream: { holdChars: 32, windowChars: 64 } },
      { client },
    );

    const { text, error } = await read(llm);

    expect(code(error)).toBe('content_blocked');
    expect(text).not.toContain('hunter');
  });
});

describe('tool calls in a stream', () => {
  it('holds the arguments until they are complete, then restores them', async () => {
    const { client } = createStreamClient((params) => {
      const token = tokenIn(params);
      const args = JSON.stringify({ to: token });
      return (async function* () {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 't1',
          name: 'send',
          argumentsDelta: args.slice(0, 8),
        } as const;
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: args.slice(8) } as const;
      })();
    });
    const { llm } = harness({ checks: [pii] }, { client });

    const { seen } = await read(llm, { ...call, userContent: 'mail jane@acme.com' });

    const calls = seen.filter((chunk) => chunk.type === 'tool_call_delta');
    expect(calls).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 't1',
        name: 'send',
        argsDelta: JSON.stringify({ to: 'jane@acme.com' }),
        complete: true,
      },
    ]);
  });
});

describe('a caller that leaves', () => {
  it('cancels the provider and still reports once', async () => {
    const { client, state } = createStreamClient(
      textDeltas('a long answer that keeps on going '.repeat(8), 40, 40, 40, 40, 40, 40),
    );
    const { llm } = harness({ checks: [pii] }, { client });

    const stream = (await llm.call(call as never)) as unknown as {
      chunks: AsyncIterable<StreamChunk>;
    };
    for await (const chunk of stream.chunks) {
      void chunk;
      break;
    }

    expect(state.finished).toBe(false);
  });
});

describe('the result event', () => {
  it('arrives when finalResult settles, not before', async () => {
    const { client } = createStreamClient(textDeltas('hello there, this is a stream', 10, 10));
    const { llm, events } = harness(
      { checks: [leak({ detect: keywords(['never']) })] },
      { client },
    );

    const stream = (await llm.call(call as never)) as unknown as {
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<unknown>;
    };
    expect(results(events)).toHaveLength(0);

    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;

    expect(results(events)).toHaveLength(1);
    expect(results(events)[0]).toMatchObject({ outcome: 'passed', output: { restored: 0 } });
  });

  it('for a stream left untouched, comes at once, with no output part', async () => {
    const { client } = createStreamClient(textDeltas('hello', 2));
    const { llm, events } = harness({ checks: [pii] }, { client });

    await llm.call(call as never);

    expect(results(events)).toHaveLength(1);
    expect(results(events)[0]!.output).toBeUndefined();
  });
});
