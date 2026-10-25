import { describe, expect, it } from 'vitest';

import { patterns, type Check, type GuardResult } from '../../src/index.js';
import { harness, lastUserText, serverError } from '../helpers.js';

const email: Check = { id: 'pii', detect: patterns(['email']), action: 'redact' };
const tokenOf = (text: string) => /x[0-9a-f]{6}@redacted\.invalid/.exec(text)?.[0];

function resultOf(events: { name: string; data: unknown }[]): GuardResult {
  const results = events.filter((event) => event.name === 'guard.result');
  expect(results).toHaveLength(1);
  return results[0]!.data as GuardResult;
}

describe('redact', () => {
  it('shows the provider a token and gives the caller the value back', async () => {
    const { llm, primary, events } = harness(
      { checks: [email] },
      {},
      { primary: (params) => `I will write to ${tokenOf(lastUserText(params))}.` },
    );

    const answer = await llm.call({ userContent: 'mail jane@acme.com', jsonMode: false });

    expect(lastUserText(primary.calls[0]!)).not.toContain('jane@acme.com');
    expect(tokenOf(lastUserText(primary.calls[0]!))).toBeDefined();
    expect(answer).toBe('I will write to jane@acme.com.');
    expect(resultOf(events)).toMatchObject({
      outcome: 'redacted',
      input: { checks: { pii: { found: 1 } } },
      output: { restored: 1, unrestored: 0 },
    });
  });

  it('keeps the same value on the same token across calls', async () => {
    const { llm, primary } = harness({ checks: [email] });

    await llm.call({ userContent: 'jane@acme.com', jsonMode: false });
    await llm.call({ userContent: 'jane@acme.com', jsonMode: false });

    expect(lastUserText(primary.calls[0]!)).toBe(lastUserText(primary.calls[1]!));
  });

  it('does not restore what restore: false keeps out of the answer', async () => {
    const { llm } = harness(
      { checks: [{ ...email, restore: false }] },
      {},
      { primary: (params) => `to ${tokenOf(lastUserText(params))}` },
    );

    const answer = await llm.call({ userContent: 'jane@acme.com', jsonMode: false });

    expect(answer).toBe('to [EMAIL]');
  });

  it('redacts only for the targets redactFor picks, and again for a fallback', async () => {
    const { llm, primary, b } = harness(
      { checks: [{ ...email, redactFor: (ctx) => ctx.isFallbackAttempt }] },
      {},
      { primary: () => serverError() },
    );

    await llm.call({ userContent: 'jane@acme.com', jsonMode: false });

    // The primary target is trusted with the value; the fallback gets a token.
    expect(lastUserText(primary.calls[0]!)).toBe('jane@acme.com');
    expect(lastUserText(b.calls[0]!)).not.toContain('jane@acme.com');
    expect(tokenOf(lastUserText(b.calls[0]!))).toBeDefined();
  });

  it('does not change the history the caller passed', async () => {
    const { llm } = harness({ checks: [email] });
    const history = [
      { role: 'user' as const, content: 'jane@acme.com' },
      { role: 'assistant' as const, content: 'ok' },
    ];

    await llm.call({ userContent: 'again', history, jsonMode: false });

    expect(history[0]!.content).toBe('jane@acme.com');
  });
});

describe('redactFor that throws', () => {
  it('redacts, because the safe answer is to hide the value', async () => {
    const { llm, primary } = harness({
      checks: [
        {
          ...email,
          redactFor: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    await llm.call({ userContent: 'jane@acme.com', jsonMode: false });

    expect(lastUserText(primary.calls[0]!)).not.toContain('jane@acme.com');
  });
});

describe('when the output gate itself fails', () => {
  const card: Check = { id: 'card', detect: patterns(['card']), action: 'redact', on: 'output' };
  const mask = (label: string) => {
    if (label === 'card') throw new Error('mask broke');
    return `[${label.toUpperCase()}]`;
  };
  const answerer = (params: Parameters<typeof lastUserText>[0]) =>
    `to ${tokenOf(lastUserText(params))} card 4111 1111 1111 1111`;

  it('fails open with the values restored, never with tokens', async () => {
    const { llm } = harness(
      { checks: [email, card], onError: 'open', mask } as never,
      {},
      { primary: answerer },
    );

    const answer = await llm.call({ userContent: 'mail jane@acme.com', jsonMode: false });

    expect(answer).toContain('jane@acme.com');
    expect(answer).not.toContain('redacted.invalid');
  });

  it('fails open with a plain answer untouched when there was nothing to restore', async () => {
    const { llm } = harness(
      { checks: [card], onError: 'open', mask } as never,
      {},
      { primary: () => 'card 4111 1111 1111 1111' },
    );

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe(
      'card 4111 1111 1111 1111',
    );
  });

  it('fails closed by default', async () => {
    const { llm } = harness({ checks: [email, card], mask } as never, {}, { primary: answerer });

    await expect(
      llm.call({ userContent: 'mail jane@acme.com', jsonMode: false }),
    ).rejects.toMatchObject({ code: 'content_blocked' });
  });
});

describe('a redact finding without a label', () => {
  const plain = (needle: string) => (segments: readonly { text: string }[]) =>
    segments.flatMap((segment, index) => {
      const at = segment.text.indexOf(needle);
      return at === -1 ? [] : [{ segment: index, start: at, end: at + needle.length }];
    });

  it('is tokenized under the label of its check, and comes back', async () => {
    const { llm, primary } = harness(
      { checks: [{ id: 'secret', detect: plain('hunter2'), action: 'redact' }] },
      {},
      { primary: (params) => `you said ${lastUserText(params)}` },
    );

    const answer = await llm.call({ userContent: 'my hunter2 here', jsonMode: false });

    expect(lastUserText(primary.calls[0]!)).toMatch(/\[SECRET_[0-9a-f]+\]/);
    expect(answer).toBe('you said my hunter2 here');
  });
});
