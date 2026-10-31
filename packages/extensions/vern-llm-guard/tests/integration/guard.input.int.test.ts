import { isLLMError, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import {
  guardLogFields,
  keywords,
  patterns,
  type Check,
  type Detector,
  type Finding,
  type GuardResult,
  type ImageDetector,
  type ImageSegment,
  type Segment,
} from '../../src/index.js';
import { captureLogger, harness } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const email: Check = { id: 'pii', detect: patterns(['email']) };
const secrets: Check = { id: 'secrets', detect: patterns(['secrets']), action: 'block' };
const awsKey = 'AKIAIOSFODNN7EXAMPLE';

/** The one guard.result of a call. */
function resultOf(events: { name: string; data: unknown }[]): GuardResult {
  const results = events.filter((event) => event.name === 'guard.result');
  expect(results).toHaveLength(1);
  return results[0]!.data as GuardResult;
}

describe('a call that passes', () => {
  it('reaches the provider untouched, with labels that say nothing was found', async () => {
    const { llm, primary, labels, events } = harness({ checks: [email, secrets] });

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(labels).toEqual([[]]);
    expect(resultOf(events)).toMatchObject({
      v: 1,
      version: 'v1',
      outcome: 'passed',
      labels: [],
      input: { checks: { pii: { found: 0 }, secrets: { found: 0 } }, errors: [], unscanned: 0 },
    });
  });

  it('with no checks at all is still a call that was checked and found nothing', async () => {
    const { llm, labels } = harness({ checks: [] });
    await llm.call(call);
    expect(labels).toEqual([[]]);
  });
});

describe('a check that labels', () => {
  it('sets the labels before next, and does not change the call', async () => {
    const { llm, primary, labels, events } = harness({ checks: [email, secrets] });

    await llm.call({ ...call, userContent: 'write to jane@acme.com' });

    expect(labels).toEqual([['pii']]);
    expect(primary.calls[0]!.messages).toEqual([
      { role: 'user', content: 'write to jane@acme.com' },
    ]);
    expect(resultOf(events)).toMatchObject({
      outcome: 'labeled',
      labels: ['pii'],
      input: { checks: { pii: { found: 1, kinds: ['email'] } } },
    });
  });

  it('uses the label of the check, not its id, and labels from every role it is on', async () => {
    const { llm, labels } = harness({
      checks: [
        { id: 'a', label: 'health', detect: keywords(['diagnosis']), on: ['system', 'tool'] },
      ],
    });

    await llm.call({
      ...call,
      systemPrompt: 'the diagnosis is private',
      userContent: 'hi',
    });
    await llm.call({ ...call, userContent: 'diagnosis' });

    expect(labels).toEqual([['health'], []]);
  });

  it('reads the history, tool results included', async () => {
    const { llm, labels } = harness({
      checks: [{ id: 'toolpii', label: 'pii', detect: patterns(['email']), on: 'tool' }],
    });

    await llm.call({
      ...call,
      history: [
        { role: 'user', content: 'look it up' },
        {
          role: 'assistant',
          toolCalls: [{ id: 't1', name: 'lookup', arguments: { q: 'jane' } }],
        },
        { role: 'tool', toolResults: [{ toolCallId: 't1', content: 'jane@acme.com' }] },
        { role: 'assistant', content: 'found her' },
      ],
      userContent: 'and now?',
    });

    expect(labels).toEqual([['pii']]);
  });
});

describe('a check that blocks', () => {
  it('refuses the call with content_blocked before any provider is contacted', async () => {
    const { llm, primary, b, labels } = harness({ checks: [secrets] });

    const error = await llm
      .call({ ...call, userContent: `key ${awsKey}` })
      .catch((e: unknown) => e);

    expect(isLLMError(error)).toBe(true);
    expect(error).toMatchObject({
      type: 'invalid_params',
      code: 'content_blocked',
      message: 'Call blocked by guard: check "secrets" (input)',
      issues: { version: 'v1', phase: 'input', checks: ['secrets'], labels: ['secrets'] },
    });
    expect(primary.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    expect(labels).toEqual([]);
  });

  it('is not retried, does not fall back and does not count toward a breaker', async () => {
    const { llm, primary, b } = harness({ checks: [secrets] }, { maxRetries: 3 });

    const error = await llm.call({ ...call, userContent: awsKey }).catch((e: unknown) => e);

    expect(error).toMatchObject({ retryable: false, countsTowardBreaker: false });
    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('never puts the content in the error or the event', async () => {
    const { llm, events } = harness({ checks: [secrets] });

    const error = (await llm
      .call({ ...call, userContent: `key ${awsKey}` })
      .catch((e: unknown) => e)) as Error;

    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(awsKey);
    expect(JSON.stringify(events)).not.toContain(awsKey);
    expect(resultOf(events)).toMatchObject({ outcome: 'blocked', labels: ['secrets'] });
  });

  it('emits the result before it refuses, so a record exists', async () => {
    const order: string[] = [];
    const { llm } = harness(
      { checks: [secrets] },
      {
        onEvent: (event) => {
          if (event.kind === 'custom') order.push(event.name);
        },
      },
    );

    await llm.call({ ...call, userContent: awsKey }).catch(() => undefined);
    expect(order).toEqual(['guard.result']);
  });

  it('still lets a call without the secret through', async () => {
    const { llm, primary } = harness({ checks: [secrets] });
    await expect(llm.call(call)).resolves.toBe('primary');
    expect(primary.calls).toHaveLength(1);
  });

  it('refuses at the first block and does not run what comes after it', async () => {
    const after = vi.fn<Detector>(() => []);
    const { llm } = harness({
      checks: [secrets, { id: 'after', detect: after }],
    });

    await llm.call({ ...call, userContent: awsKey }).catch(() => undefined);
    expect(after).not.toHaveBeenCalled();
  });
});

describe('audit mode', () => {
  it('reports what a check would do and changes nothing', async () => {
    const { llm, primary, labels, events } = harness({
      checks: [
        { ...secrets, mode: 'audit' },
        { ...email, mode: 'audit' },
      ],
    });

    await expect(llm.call({ ...call, userContent: `${awsKey} jane@acme.com` })).resolves.toBe(
      'primary',
    );

    expect(primary.calls).toHaveLength(1);
    expect(labels).toEqual([[]]);
    expect(resultOf(events)).toMatchObject({
      outcome: 'passed',
      labels: [],
      input: { audit: { secrets: 'block', pii: 'label' } },
    });
  });
});

describe('a check that fails', () => {
  const broken: Detector = () => {
    throw new Error(`leaks ${awsKey}`);
  };

  it('blocks by default when it blocks, and says the check could not be evaluated', async () => {
    const { llm, primary, events } = harness({
      checks: [{ id: 'model', detect: broken, action: 'block' }],
    });

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'content_blocked',
      message: 'Call blocked by guard: check "model" could not be evaluated (input)',
      issues: { checks: ['model'], failed: true },
    });
    expect(primary.calls).toHaveLength(0);
    expect(resultOf(events).input.errors).toEqual([{ check: 'model', name: 'Error' }]);
    expect(JSON.stringify(events)).not.toContain(awsKey);
  });

  it('leaves the labels unknown when it labels, so policy applies its label rules', async () => {
    const { llm, primary, labels, events } = harness({
      checks: [{ id: 'model', detect: broken }],
    });

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(primary.calls).toHaveLength(1);
    expect(labels).toEqual([undefined]);
    const result = resultOf(events);
    expect(result).not.toHaveProperty('labels');
    expect(result.input.errors).toEqual([{ check: 'model', name: 'Error' }]);
  });

  it('never puts its error message in the logs', async () => {
    const { logger, everything } = captureLogger();
    const secret: Detector = () => {
      throw new Error('leaks hunter2');
    };
    const { llm } = harness({
      checks: [{ id: 'model', detect: secret, action: 'block', onError: 'open' }],
      logger,
    });

    await llm.call(call);

    expect(everything()).not.toContain('hunter2');
  });

  it('is skipped when it fails open', async () => {
    const { llm, labels } = harness({
      checks: [{ id: 'model', detect: broken, action: 'block', onError: 'open' }],
    });

    await expect(llm.call(call)).resolves.toBe('primary');
    expect(labels).toEqual([[]]);
  });

  it('times out, and then follows the same rule', async () => {
    const hang: Detector = () => new Promise(() => {});
    const { llm, primary } = harness({
      checks: [{ id: 'model', detect: hang, action: 'block', timeoutMs: 20 }],
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'content_blocked' });
    expect(primary.calls).toHaveLength(0);
  });
});

describe('async detectors', () => {
  it('are awaited before the call goes on, and their findings label it', async () => {
    const classifier: Detector = async (segments) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return segments.flatMap((segment, index) =>
        segment.text.includes('diabetes') ? [{ segment: index, label: 'condition' }] : [],
      );
    };
    const { llm, labels } = harness({ checks: [{ id: 'health', detect: classifier }] });

    await llm.call({ ...call, userContent: 'I have diabetes' });
    await llm.call(call);

    expect(labels).toEqual([['health'], []]);
  });

  it('ask the detector once per call, for every segment', async () => {
    const detect = vi.fn<Detector>(async () => []);
    const { llm } = harness({ checks: [{ id: 'model', detect }] });

    await llm.call({ ...call, systemPrompt: 'rules', userContent: 'one' });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]![0]).toEqual([
      { text: 'rules', source: 'system' },
      { text: 'one', source: 'user' },
    ]);
  });

  it('are not asked again about a long conversation they already read', async () => {
    const detect = vi.fn<Detector>(async () => []);
    const { llm } = harness({ checks: [{ id: 'model', detect }] });
    const history = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
    ];

    await llm.call({ ...call, history, userContent: 'second question' });
    await llm.call({
      ...call,
      history: [
        ...history,
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer' },
      ],
      userContent: 'third question',
    });

    const asked = detect.mock.calls.map(([segments]) => segments.map((segment) => segment.text));
    expect(asked).toEqual([
      ['first question', 'first answer', 'second question'],
      ['second answer', 'third question'],
    ]);
  });
});

describe('when', () => {
  it('turns a check on for some calls only', async () => {
    const { llm, labels } = harness({
      checks: [{ ...email, when: (ctx) => ctx.context?.tenantId === 'acme' }],
    });

    await llm.call({ ...call, userContent: 'jane@acme.com', context: { tenantId: 'acme' } });
    await llm.call({ ...call, userContent: 'jane@acme.com', context: { tenantId: 'other' } });

    expect(labels).toEqual([['pii'], []]);
  });
});

describe('what a log record can carry', () => {
  it('gives the outcome, the labels and the time to a middleware outside the guard', async () => {
    let fields: ReturnType<typeof guardLogFields>;
    const logger: VernLLMMiddleware = {
      name: 'logger',
      position: 'outermost',
      wrap: async (_request, next, ctx) => {
        const result = await next().catch((error: unknown) => {
          fields = guardLogFields(ctx);
          throw error;
        });
        fields = guardLogFields(ctx);
        return result;
      },
    };
    const { llm } = harness({ checks: [email, secrets] }, { middleware: [logger] });

    await llm.call({ ...call, userContent: 'jane@acme.com' });
    expect(fields).toEqual({
      guard_outcome: 'labeled',
      guard_labels: ['pii'],
      guard_ms: expect.any(Number),
    });

    await llm.call({ ...call, userContent: awsKey }).catch(() => undefined);
    expect(fields).toMatchObject({ guard_outcome: 'blocked' });
  });

  it('is empty when the guard did not run', () => {
    expect(
      guardLogFields({ state: { get: () => undefined, set: () => undefined } }),
    ).toBeUndefined();
  });
});

describe('images', () => {
  it('are counted as unscanned, since no text detector can read them', async () => {
    const { llm, events } = harness({ checks: [email] });

    await llm.call({
      ...call,
      userContent: [
        { type: 'text', text: 'what is this' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    });

    expect(resultOf(events).input.unscanned).toBe(1);
  });
});

describe('images a check reads', () => {
  const violent = { type: 'image' as const, data: 'VIOLENT', mimeType: 'image/png' };
  const calm = { type: 'image' as const, data: 'calm', mimeType: 'image/png' };
  const withImage = (...blocks: (typeof violent)[]) => ({
    ...call,
    userContent: [{ type: 'text' as const, text: 'what is this' }, ...blocks],
  });

  /** An image detector that flags `VIOLENT`, and remembers every image it was given. */
  function looks(skip = false) {
    const seen: ImageSegment[] = [];
    const detect: ImageDetector = Object.assign(
      (segments: readonly (Segment | ImageSegment)[]) =>
        segments.flatMap((segment, index): Finding[] => {
          if (!('image' in segment)) return [];
          seen.push(segment);
          if (skip) return [{ segment: index, unscanned: true as const }];
          return segment.image.data === 'VIOLENT' ? [{ segment: index, label: 'violent' }] : [];
        }),
      { images: true as const },
    );
    return { detect, seen };
  }

  it('blocks the call before any provider is contacted', async () => {
    const { detect } = looks();
    const { llm, primary, events } = harness({
      checks: [{ id: 'pic', detect, action: 'block' }],
    });

    const error = await llm.call(withImage(calm, violent)).catch((e: unknown) => e);

    expect(isLLMError(error) && error.code).toBe('content_blocked');
    expect(primary.calls).toHaveLength(0);
    expect(resultOf(events)).toMatchObject({
      outcome: 'blocked',
      input: { checks: { pic: { found: 1, kinds: ['violent'] } }, unscanned: 0 },
    });
  });

  it('lets a call with a harmless image through, and the image reaches the provider intact', async () => {
    const { detect, seen } = looks();
    const { llm, primary, events } = harness({ checks: [{ id: 'pic', detect, action: 'block' }] });

    await llm.call(withImage(calm));

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(primary.calls[0]!.messages)).toContain('calm');
    expect(resultOf(events).input.unscanned).toBe(0);
  });

  it('never gives an image to a text check beside it, which keeps reading the text', async () => {
    const { detect } = looks();
    const { llm, labels } = harness({ checks: [email, { id: 'pic', detect }] });

    await llm.call({
      ...call,
      userContent: [{ type: 'text', text: 'jane@acme.com' }, violent],
    });

    expect(labels).toEqual([['pii', 'pic']]);
  });

  it('counts an image as unscanned when the only image check is on another role', async () => {
    const { detect, seen } = looks();
    const { llm, events } = harness({ checks: [{ id: 'pic', detect, on: 'tool' }] });

    await llm.call(withImage(violent));

    expect(seen).toHaveLength(0);
    expect(resultOf(events).input.unscanned).toBe(1);
  });

  it('counts an image as unscanned when the detector says it could not read it', async () => {
    const { detect } = looks(true);
    const { llm, events } = harness({ checks: [{ id: 'pic', detect, action: 'block' }] });

    await llm.call(withImage(violent, calm));

    expect(resultOf(events).input.unscanned).toBe(2);
  });

  it('blocks a redact check that finds something in an image, since it has no span to mask', async () => {
    const { detect } = looks();
    const { llm, primary, events } = harness({
      checks: [{ id: 'pic', detect, action: 'redact' }],
    });

    await expect(llm.call(withImage(violent))).rejects.toMatchObject({ code: 'content_blocked' });

    expect(primary.calls).toHaveLength(0);
    expect(resultOf(events).input.checks.pic).toMatchObject({ found: 1, unredactable: 1 });
  });

  it('reads the image of a check that runs alongside the call, and counts it as read', async () => {
    const { detect } = looks();
    const { llm, primary, events } = harness({
      checks: [{ id: 'pic', detect, action: 'block', parallel: true }],
    });

    await expect(llm.call(withImage(violent))).rejects.toMatchObject({ code: 'content_blocked' });
    await llm.call(withImage(calm));

    // A check that answers at once is joined before the call, so the block costs no provider call.
    expect(primary.calls).toHaveLength(1);
    const [blocked, passed] = events
      .filter((event) => event.name === 'guard.result')
      .map((event) => event.data as GuardResult);
    expect(blocked!.input.unscanned).toBe(0);
    expect(passed!.input.unscanned).toBe(0);
  });

  it('reads an image that comes back in the next call once, since it is in the memo', async () => {
    const { detect, seen } = looks();
    const { llm } = harness({ checks: [{ id: 'pic', detect }] });

    await llm.call(withImage(calm));
    await llm.call(withImage(calm));
    await llm.call(withImage(violent));

    expect(seen.map((segment) => segment.image.data)).toEqual(['calm', 'VIOLENT']);
  });
});
