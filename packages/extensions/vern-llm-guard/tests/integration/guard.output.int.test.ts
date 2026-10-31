import { isLLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  keywords,
  patterns,
  type CallView,
  type Check,
  type Detector,
  type GuardResult,
} from '../../src/index.js';
import { createStreamClient, harness, textDeltas } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const out = (check: Partial<Check> & Pick<Check, 'id' | 'detect'>): Check => ({
  on: 'output',
  ...check,
});

function resultOf(events: { name: string; data: unknown }[]): GuardResult {
  const results = events.filter((event) => event.name === 'guard.result');
  expect(results).toHaveLength(1);
  return results[0]!.data as GuardResult;
}

describe('the output gate', () => {
  it('blocks a plain answer that holds what a block check forbids', async () => {
    const { llm, events } = harness(
      { checks: [out({ id: 'leak', detect: keywords(['hunter2']), action: 'block' })] },
      {},
      { primary: () => 'the password is hunter2' },
    );

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(isLLMError(error) && error.code).toBe('content_blocked');
    expect(resultOf(events)).toMatchObject({
      outcome: 'blocked',
      output: { checks: { leak: { found: 1 } } },
    });
  });

  it('masks what a redact check finds in the answer', async () => {
    const { llm } = harness(
      { checks: [out({ id: 'pii', detect: patterns(['email']), action: 'redact' })] },
      {},
      { primary: () => 'write to bob@other.com' },
    );

    await expect(llm.call(call)).resolves.toBe('write to [EMAIL]');
  });

  it('uses the mask option for the text', async () => {
    const { llm } = harness(
      {
        checks: [out({ id: 'pii', detect: patterns(['email']), action: 'redact' })],
        mask: (label) => `<${label}>`,
      },
      {},
      { primary: () => 'write to bob@other.com' },
    );

    await expect(llm.call(call)).resolves.toBe('write to <email>');
  });

  it('does not flag the value the caller sent when it comes back restored', async () => {
    const { llm } = harness(
      {
        checks: [
          { id: 'in', detect: patterns(['email']), action: 'redact' },
          out({ id: 'out', detect: patterns(['email']), action: 'block' }),
        ],
      },
      {},
      { primary: () => 'sent to jane@acme.com' },
    );

    // The raw echo becomes the caller's own token, so the output check skips it and restores it.
    await expect(llm.call({ userContent: 'jane@acme.com', jsonMode: false })).resolves.toBe(
      'sent to jane@acme.com',
    );
  });

  it('checks a tool call, and restores values in its arguments', async () => {
    const { llm } = harness(
      { checks: [{ id: 'in', detect: patterns(['email']), action: 'redact' }] },
      {},
      {
        primary: (params) => {
          const text = JSON.stringify(params.messages);
          const token = /x[0-9a-f]{6}@redacted\.invalid/.exec(text)![0];
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 't1',
                      type: 'function',
                      function: { name: 'send', arguments: JSON.stringify({ to: token }) },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    );

    const result = (await llm.call({
      userContent: 'jane@acme.com',
      jsonMode: false,
      tools: [{ name: 'send', description: 'send', parameters: { type: 'object' } }],
    } as never)) as unknown as { toolCalls: { arguments: unknown }[] };

    expect(result.toolCalls[0]!.arguments).toEqual({ to: 'jane@acme.com' });
  });
});

describe('an output check that breaks', () => {
  it('ends the call without a label when the guard fails closed', async () => {
    const { llm } = harness({
      checks: [
        {
          id: 'o',
          action: 'block',
          on: 'output',
          detect: () => {
            throw new Error('x');
          },
        },
      ],
    });

    const error = await llm.call({ userContent: 'hi', jsonMode: false }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'content_blocked', issues: { failed: true, labels: [] } });
  });
});

describe('a check that is given the call', () => {
  const toolHistory = [
    { role: 'user' as const, content: 'look it up' },
    { role: 'assistant' as const, toolCalls: [{ id: 't1', name: 'fetch', arguments: { q: 'x' } }] },
    { role: 'tool' as const, toolResults: [{ toolCallId: 't1', content: 'balance is 42' }] },
  ];

  /** A detector that wants the call, and records what it was given. */
  function viewing() {
    const views: (CallView | undefined)[] = [];
    const detect: Detector = Object.assign(
      (_segments: unknown, _signal: AbortSignal, view?: CallView) => {
        views.push(view);
        return [];
      },
      { callView: true as const },
    );
    return { detect, views };
  }

  it('reads the request next to a plain answer, and what answered it', async () => {
    const { detect, views } = viewing();
    const { llm } = harness({ checks: [out({ id: 'grounded', detect })] });

    await llm.call({ ...call, history: toolHistory, userContent: 'what is my balance' });

    expect(views).toHaveLength(1);
    const view = views[0]!;
    expect(view.input).toEqual([
      { text: 'look it up', source: 'user' },
      { text: '{"q":"x"}', source: 'assistant' },
      { text: 'balance is 42', source: 'tool' },
      { text: 'what is my balance', source: 'user' },
    ]);
    expect(view.meta).toMatchObject({ model: 'primary-model', usedFallback: false });
  });

  it('shows a value that was replaced as its token, as the answer is', async () => {
    const { detect, views } = viewing();
    const { llm } = harness({
      checks: [
        { id: 'pii', detect: patterns(['email']), action: 'redact' },
        out({ id: 'g', detect }),
      ],
    });

    await llm.call({ ...call, userContent: 'mail jane@acme.com about it' });

    const text = views[0]!.input.map((segment) => segment.text).join(' ');
    expect(text).not.toContain('jane@acme.com');
    expect(text).toMatch(/redacted\.invalid/);
  });

  it('is asked again for the same answer in the next call, since it is never memoized', async () => {
    const { detect, views } = viewing();
    const { llm } = harness({ checks: [out({ id: 'grounded', detect })] });

    await llm.call(call);
    await llm.call(call);

    expect(views).toHaveLength(2);
  });

  it('is not given the call by a check that did not ask for it', async () => {
    const plain = [] as unknown[][];
    const detect: Detector = (...args) => {
      plain.push(args);
      return [];
    };
    const { llm } = harness({ checks: [out({ id: 'plain', detect })] });

    await llm.call(call);

    expect(plain[0]).toHaveLength(2);
  });

  it('gets no call for a check on the request, where there is only the request', async () => {
    const { detect, views } = viewing();
    const { llm } = harness({ checks: [{ id: 'in', detect }] });

    await llm.call(call);

    // Once in `wrap`, and once more in `transform`, which reads again what other transforms added.
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((view) => view === undefined)).toBe(true);
  });

  it('gets the meta of a stream only when its whole answer is checked, never while it arrives', async () => {
    const { detect, views } = viewing();
    const { client } = createStreamClient(textDeltas('the balance is 42', 4, 4));
    const { llm } = harness({ checks: [out({ id: 'grounded', detect })] }, { client });

    const stream = (await llm.call({ ...call, stream: true as const })) as unknown as {
      chunks: AsyncIterable<unknown>;
      finalResult: Promise<unknown>;
    };
    for await (const _chunk of stream.chunks) {
      // Read to the end.
    }
    await stream.finalResult;

    // The windows of text get the request alone, and only the whole answer gets what answered.
    expect(views.length).toBeGreaterThan(1);
    expect(views.every((view) => view !== undefined)).toBe(true);
    const withMeta = views.filter((view) => view?.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0]!.meta).toMatchObject({ model: 'primary-model' });
  });
});
