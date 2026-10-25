import { isLLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { keywords, patterns, type Check, type GuardResult } from '../../src/index.js';
import { harness } from '../helpers.js';

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
