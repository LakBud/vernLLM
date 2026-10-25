import { isLLMError, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { keywords, patterns, type Check, type GuardResult } from '../../src/index.js';
import { captureLogger, harness, lastUserText } from '../helpers.js';

const email: Check = { id: 'pii', detect: patterns(['email']), action: 'redact' };

/** Adds text to the last user message, as a retrieval or memory middleware would. */
function addition(text: string, priority?: number): VernLLMMiddleware {
  return {
    name: `add-${text}`,
    ...(priority === undefined ? {} : { priority }),
    transform: ({ messages }) => ({
      messages: messages.map((message, index) =>
        index === messages.length - 1 &&
        message.role === 'user' &&
        typeof message.content === 'string'
          ? { ...message, content: `${message.content} ${text}` }
          : message,
      ),
    }),
  };
}

function resultOf(events: { name: string; data: unknown }[]): GuardResult {
  const results = events.filter((event) => event.name === 'guard.result');
  expect(results).toHaveLength(1);
  return results[0]!.data as GuardResult;
}

describe('content added by another transform', () => {
  it('is scanned and redacted, and counted as late', async () => {
    const { llm, primary, events } = harness(
      { checks: [email] },
      { middleware: [addition('note: bob@other.com')] },
    );

    await llm.call({ userContent: 'hello', jsonMode: false });

    const sent = lastUserText(primary.calls[0]!);
    expect(sent).toContain('hello');
    expect(sent).toContain('note:');
    expect(sent).not.toContain('bob@other.com');
    expect(resultOf(events)).toMatchObject({ input: { late: 1 } });
  });

  it('has its redacted values restored in the answer', async () => {
    const { llm } = harness(
      { checks: [{ ...email, restore: true } as Check] },
      { middleware: [addition('note: bob@other.com')] },
      { primary: (params) => `echo: ${lastUserText(params)}` },
    );

    const answer = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(answer).toContain('bob@other.com');
    expect(answer).not.toContain('redacted.invalid');
  });

  it('ends the call when what it added is blocked', async () => {
    const { llm, primary } = harness(
      { checks: [{ id: 'k', detect: keywords(['hunter2']), action: 'block' }] },
      { middleware: [addition('hunter2')] },
    );

    const error = await llm
      .call({ userContent: 'hello', jsonMode: false })
      .catch((e: unknown) => e);

    expect(isLLMError(error) && error.code).toBe('content_blocked');
    expect(primary.calls).toHaveLength(0);
  });

  it('keeps what earlier transforms added exactly once', async () => {
    const { llm, primary } = harness(
      { checks: [email] },
      { middleware: [addition('first'), addition('second!')] },
    );

    await llm.call({ userContent: 'jane@acme.com', jsonMode: false });

    const sent = lastUserText(primary.calls[0]!);
    expect(sent.match(/first/g)).toHaveLength(1);
    expect(sent.match(/second!/g)).toHaveLength(1);
    expect(sent).not.toContain('jane@acme.com');
  });
});

describe('a check that breaks on what another transform added', () => {
  const picky = (id = 'picky'): Check => ({
    id,
    detect: (segments) => {
      if (segments.some((segment) => segment.text.includes('LATE'))) throw new Error('x');
      return [];
    },
    action: 'block',
  });

  it('keeps one error for it, when the guard fails open', async () => {
    const { llm, events } = harness(
      { checks: [picky()], onError: 'open' },
      { middleware: [addition('LATE'), addition('LATE again', 5)] },
    );

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(resultOf(events).input.errors).toEqual([{ check: 'picky', name: 'Error' }]);
  });

  it('keeps one error when it broke the first scan as well', async () => {
    const always: Check = {
      id: 'always',
      detect: () => {
        throw new Error('x');
      },
      action: 'block',
      onError: 'open',
    };
    const { llm, events } = harness({ checks: [always] }, { middleware: [addition('more')] });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(resultOf(events).input.errors).toEqual([{ check: 'always', name: 'Error' }]);
  });

  it('ends the call when the guard fails closed', async () => {
    const { llm, primary } = harness({ checks: [picky()] }, { middleware: [addition('LATE')] });

    const error = await llm
      .call({ userContent: 'hello', jsonMode: false })
      .catch((e: unknown) => e);

    expect(isLLMError(error) && error.code).toBe('content_blocked');
    expect(primary.calls).toHaveLength(0);
  });

  it('redacts a finding without a label under the label of its check', async () => {
    const plain: Check = {
      id: 'secret',
      detect: (segments) =>
        segments.flatMap((segment, index) => {
          const at = segment.text.indexOf('hunter2');
          return at === -1 ? [] : [{ segment: index, start: at, end: at + 7 }];
        }),
      action: 'redact',
    };
    const { llm, primary } = harness({ checks: [plain] }, { middleware: [addition('hunter2')] });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(lastUserText(primary.calls[0]!)).toMatch(/\[SECRET_[0-9a-f]+\]/);
  });
});

describe('a transform that runs after the guard', () => {
  it('warns once, because what it adds is not checked', async () => {
    const { logger, warnings } = captureLogger();
    const { llm, primary } = harness(
      { checks: [email], logger },
      { middleware: [addition('late bob@other.com', Number.MAX_SAFE_INTEGER)] },
    );

    await llm.call({ userContent: 'hello', jsonMode: false });
    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(warnings().filter((message) => message.includes('transform runs after'))).toHaveLength(
      1,
    );
    expect(lastUserText(primary.calls[0]!)).toContain('bob@other.com');
  });
});
