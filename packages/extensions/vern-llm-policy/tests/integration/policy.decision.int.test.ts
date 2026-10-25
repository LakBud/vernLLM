import { LLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { captureLogger, fakeContext, harness, request } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const swallow = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the policy.decision event', () => {
  it('is emitted once per call, before anything inside runs', async () => {
    const { llm, order } = harness({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    await llm.call(call);

    expect(order).toEqual(['event:policy.decision', 'inside']);
  });

  it('carries the version, outcome and removals, and nothing from the call', async () => {
    const { llm, events } = harness({
      version: '2026-10-01',
      rules: [{ id: 'no-b', forbid: { name: 'b' } }],
    });

    await llm.call({ ...call, userContent: 'private words', context: { token: 'sk_secret_1' } });

    expect(events).toEqual([
      {
        name: 'policy.decision',
        data: {
          v: 1,
          version: '2026-10-01',
          outcome: 'narrowed',
          removed: { b: 'no-b' },
          audit: {},
          errors: [],
          flags: {},
          exceptions: [],
        },
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('private words');
    expect(serialized).not.toContain('sk_secret_1');
  });

  it('leaves the version out when none was set', async () => {
    const { llm, events } = harness();

    await llm.call(call);

    expect(events[0]!.data).toEqual({
      v: 1,
      outcome: 'allowed',
      removed: {},
      audit: {},
      errors: [],
      flags: {},
      exceptions: [],
    });
  });

  it('is emitted for a denied call too, and nothing inside is reached', async () => {
    const { llm, events, order, tried } = harness({
      version: 'v7',
      rules: [{ id: 'lockout', forbid: 'all' }],
    });

    await swallow(llm.call(call));

    expect(order).toEqual(['event:policy.decision']);
    expect(tried()).toEqual([]);
    expect(events[0]!.data).toMatchObject({
      version: 'v7',
      outcome: 'denied',
      removed: { primary: 'lockout', b: 'lockout', c: 'lockout' },
    });
  });

  it('is emitted once for each call', async () => {
    const { llm, events } = harness();

    await llm.call(call);
    await llm.call(call);

    expect(events).toHaveLength(2);
  });

  it('is emitted when the call goes on to fail', async () => {
    const { llm, events } = harness({}, { primary: [new Error('nope')] }, { fallback: [] });

    await swallow(llm.call(call));

    expect(events).toHaveLength(1);
  });

  it('is emitted for a cache miss and for a hit, one for each call made', async () => {
    const { llm, events, tried } = harness();
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(tried()).toEqual(['primary']);
    expect(events).toHaveLength(2);
  });

  it('carries the errors a rule raised', async () => {
    const { llm, events } = harness({
      rules: [
        {
          id: 'broken',
          forbid: { name: 'b' },
          when: () => {
            throw new Error('lookup failed');
          },
        },
      ],
    });

    await llm.call(call);

    expect(events[0]!.data).toMatchObject({
      removed: { b: 'broken' },
      errors: [{ rule: 'broken', name: 'Error' }],
    });
  });
});

describe('what a failing rule said', () => {
  const leaky = {
    id: 'leaky',
    forbid: { name: 'b' },
    when: (facts: { context?: { secret?: string } }) => {
      throw new Error(`bad tenant ${facts.context?.secret}`);
    },
  };

  it('never reaches the event, which holds the kind of error and nothing it said', async () => {
    const { llm, events } = harness({ rules: [leaky] });

    await llm.call({ ...call, context: { secret: 'sk_live_1' } });

    expect(events[0]!.data).toMatchObject({ errors: [{ rule: 'leaky', name: 'Error' }] });
    expect(JSON.stringify(events)).not.toContain('sk_live_1');
  });

  it('is listed once, however many calls raise it', async () => {
    const { llm, events } = harness({ rules: [leaky] });

    await llm.call({ ...call, context: { secret: 'a' } });
    await llm.call({ ...call, context: { secret: 'b' } });

    expect(events.map((event) => (event.data as { errors: unknown[] }).errors)).toEqual([
      [{ rule: 'leaky', name: 'Error' }],
      [{ rule: 'leaky', name: 'Error' }],
    ]);
  });
});

describe('the version', () => {
  it('is in the denial issues', async () => {
    const { llm } = harness({ version: 'v3', rules: [{ id: 'lockout', forbid: 'all' }] });

    const error = (await swallow(llm.call(call))) as LLMError;

    expect(error.code).toBe('policy_denied');
    expect(error.issues).toMatchObject({ version: 'v3', rules: ['lockout'] });
  });
});

describe('an audit rule in a real call', () => {
  it('lets the call run on every target and reports what it would have removed', async () => {
    const { llm, probe, events } = harness({
      rules: [{ id: 'trial', forbid: { name: ['b', 'c'] }, mode: 'audit' }],
    });

    expect(await llm.call(call)).toBe('primary');

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    expect(events[0]!.data).toMatchObject({
      outcome: 'allowed',
      removed: {},
      audit: { trial: ['b', 'c'] },
    });
  });

  it('reports the default of deny under "default" without denying', async () => {
    const { llm, events } = harness({ default: 'deny', mode: 'audit' });

    expect(await llm.call(call)).toBe('primary');

    expect(events[0]!.data).toMatchObject({ audit: { default: ['primary', 'b', 'c'] } });
  });
});

describe('a policy that cannot be evaluated', () => {
  // A rule asking about images reads `request.messages`, which this request does not have.
  const rules = [{ id: 'pics', forbid: 'all' as const, when: { request: { images: true } } }];
  const broken = { ...request, messages: undefined } as unknown as typeof request;

  it('denies the call when closed, logs the failure and still emits the event', async () => {
    const log = captureLogger();
    const events: { name: string; data: unknown }[] = [];
    const policy = policyMiddleware({ logger: log.logger, version: 'v1', rules });
    const next = () => Promise.reject(new Error('should not run'));

    const error = await swallow(
      policy.wrap!(broken, next as never, {
        ...fakeContext(),
        emit: (name, data) => void events.push({ name, data }),
      }),
    );

    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).code).toBe('policy_denied');
    expect((error as LLMError).message).toBe(
      'Call denied by policy: the policy could not be evaluated',
    );
    expect(log.errors()).toEqual([expect.stringContaining('[VernLLM] policy: evaluate failed')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ version: 'v1', outcome: 'denied' });
  });

  it('runs the call untouched when open', async () => {
    const log = captureLogger();
    const policy = policyMiddleware({ logger: log.logger, onError: 'open', rules });
    let nextArgs: unknown[] | undefined;

    const result = await policy.wrap!(
      broken,
      ((...args: unknown[]) => {
        nextArgs = args;
        return Promise.resolve('ran');
      }) as never,
      fakeContext(),
    );

    expect(result).toBe('ran');
    expect(nextArgs).toEqual([]);
    expect(log.errors()).toHaveLength(1);
  });
});
