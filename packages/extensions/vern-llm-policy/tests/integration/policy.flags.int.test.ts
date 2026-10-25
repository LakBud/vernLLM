import { describe, expect, it } from 'vitest';

import { policyFlags, policyMiddleware } from '../../src/index.js';
import { fakeContext, harness, request } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

describe('flags in a real call', () => {
  it('reach a middleware inside policy, before next() is called', async () => {
    const { llm, probe } = harness({
      rules: [{ id: 'pii-zdr', set: { duplicateSends: false, logContent: false } }],
    });

    await llm.call(call);

    expect(probe.flags).toEqual([{ duplicateSends: false, logContent: false }]);
  });

  it('are empty when no rule set one', async () => {
    const { llm, probe } = harness({ rules: [{ id: 'a', forbid: { name: 'b' } }] });

    await llm.call(call);

    expect(probe.flags).toEqual([{}]);
  });

  it('let false win when rules disagree', async () => {
    const { llm, probe } = harness({
      rules: [
        { id: 'yes', set: { logContent: true, cacheable: true } },
        { id: 'no', set: { logContent: false } },
      ],
    });

    await llm.call(call);

    expect(probe.flags).toEqual([{ logContent: false, cacheable: true }]);
  });

  it('are decided afresh for each call', async () => {
    const { llm, probe } = harness({
      rules: [{ id: 'pii', set: { logContent: false }, when: { context: { pii: true } } }],
    });

    await llm.call({ ...call, context: { pii: true } });
    await llm.call({ ...call, context: { pii: false } });
    await llm.call({ ...call, context: { pii: true } });

    expect(probe.flags).toEqual([{ logContent: false }, {}, { logContent: false }]);
  });

  it('come with the removals of the same rule, and the event names the rule behind each', async () => {
    const { llm, probe, events } = harness({
      rules: [
        {
          id: 'pii-zdr',
          forbid: { name: 'b' },
          set: { duplicateSends: false },
        },
      ],
    });

    await llm.call(call);

    expect(probe.seen).toEqual([['primary', 'c']]);
    expect(probe.flags).toEqual([{ duplicateSends: false }]);
    expect(events[0]!.data).toMatchObject({
      removed: { b: 'pii-zdr' },
      flags: { duplicateSends: 'pii-zdr' },
    });
  });

  it('are not set by an audit rule', async () => {
    const { llm, probe, events } = harness({
      rules: [{ id: 'trial', set: { logContent: false }, mode: 'audit' }],
    });

    await llm.call(call);

    expect(probe.flags).toEqual([{}]);
    expect(events[0]!.data).toMatchObject({ flags: {} });
  });
});

describe('flags read straight from the context', () => {
  it('are stored by policy and read back with policyFlags, with no policy instance', async () => {
    const policy = policyMiddleware({
      logger: 'silent',
      rules: [{ id: 'pii', set: { duplicateSends: false } }],
    });
    const ctx = fakeContext();

    expect(policyFlags(ctx)).toEqual({});
    await policy.wrap!(request, (() => Promise.resolve('ran')) as never, ctx);

    expect(policyFlags(ctx)).toEqual({ duplicateSends: false });
  });
});
