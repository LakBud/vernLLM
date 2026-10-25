import { LLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { captureLogger, harness } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

async function denial(promise: Promise<unknown>): Promise<LLMError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LLMError);
  return error as LLMError;
}

describe('a denied call', () => {
  const lockout = {
    id: 'lockout',
    forbid: 'all' as const,
    when: { context: { status: 'suspended' } },
  };

  it('fails with policy_denied, naming the rule and every removed target', async () => {
    const { llm } = harness({ rules: [lockout] });

    const error = await denial(llm.call({ ...call, context: { status: 'suspended' } }));

    expect(error.type).toBe('invalid_params');
    expect(error.code).toBe('policy_denied');
    expect(error.message).toBe('Call denied by policy: lockout removed every target');
    expect(error.issues).toEqual({
      rules: ['lockout'],
      removed: { primary: 'lockout', b: 'lockout', c: 'lockout' },
    });
  });

  it('contacts no provider, tries no fallback and never reaches the middleware inside', async () => {
    const { llm, probe, tried } = harness({ rules: [lockout] });

    await denial(llm.call({ ...call, context: { status: 'suspended' } }));

    expect(tried()).toEqual([]);
    expect(probe.seen).toEqual([]);
  });

  it('is not retryable and never counts toward a breaker', async () => {
    const { llm } = harness(
      { rules: [lockout] },
      {},
      { maxRetries: 3, circuitBreaker: { threshold: 1 } },
    );

    const error = await denial(llm.call({ ...call, context: { status: 'suspended' } }));
    await denial(llm.call({ ...call, context: { status: 'suspended' } }));

    expect(error.retryable).toBe(false);
    expect(error.countsTowardBreaker).toBe(false);
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('lets the same caller through once the rule no longer applies', async () => {
    const { llm } = harness({ rules: [lockout] });

    await denial(llm.call({ ...call, context: { status: 'suspended' } }));

    expect(await llm.call({ ...call, context: { status: 'active' } })).toBe('primary');
  });

  it('says so when the default is deny and no rule allows a target', async () => {
    const { llm } = harness({ default: 'deny' });

    const error = await denial(llm.call(call));

    expect(error.message).toBe(
      'Call denied by policy: the default is deny and no rule allows any target',
    );
    expect(error.issues).toEqual({
      rules: [],
      removed: { primary: 'default', b: 'default', c: 'default' },
    });
  });

  it('names both a rule and the default when both removed targets', async () => {
    const { llm } = harness({
      default: 'deny',
      rules: [{ id: 'no-primary', forbid: { name: 'primary' } }],
    });

    const error = await denial(llm.call(call));

    expect(error.message).toBe(
      'Call denied by policy: no-primary and the default deny removed every target',
    );
  });

  it('denies when every target falls outside the allow rules, naming the allow rule', async () => {
    const { llm } = harness({ rules: [{ id: 'only-x', allow: { name: 'x' } }] });

    const error = await denial(llm.call(call));

    expect(error.message).toBe('Call denied by policy: only-x removed every target');
  });

  it('keeps context values out of the message and the issues', async () => {
    const { llm } = harness({ rules: [lockout] });

    const error = await denial(
      llm.call({ ...call, context: { status: 'suspended', apiKey: 'sk_secret_123', user: 'ada' } }),
    );

    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('sk_secret_123');
    expect(serialized).not.toContain('suspended');
    expect(serialized).not.toContain('ada');
  });
});

describe('a rule that throws', () => {
  const broken = {
    id: 'broken',
    forbid: { name: 'b' },
    when: () => {
      throw new Error('lookup failed');
    },
  };

  it('fails closed by default: the forbid applies, and the rest of the call carries on', async () => {
    const log = captureLogger();
    const { llm, probe } = harness({ logger: log.logger, rules: [broken] });

    expect(await llm.call(call)).toBe('primary');

    expect(probe.seen).toEqual([['primary', 'c']]);
    expect(log.warnings()).toEqual([
      `[VernLLM] policy: rule "broken" threw while deciding a call, so it fails closed: lookup failed`,
    ]);
  });

  it('is skipped under onError open', async () => {
    const { llm, probe } = harness({ onError: 'open', rules: [broken] });

    await llm.call(call);

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
  });

  it('is reported once however many calls hit it', async () => {
    const log = captureLogger();
    const { llm } = harness({ logger: log.logger, rules: [broken] });

    await llm.call(call);
    await llm.call(call);
    await llm.call(call);

    expect(log.warnings()).toHaveLength(1);
  });
});
