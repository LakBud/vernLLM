import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { captureLogger, harness, targetChain, targetProbe } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

describe('narrowing', () => {
  it('leaves a call alone when no rule applies', async () => {
    const { llm, probe, tried } = harness({
      rules: [{ id: 'free', forbid: 'all', when: { context: { plan: 'free' } } }],
    });

    expect(await llm.call({ ...call, context: { plan: 'pro' } })).toBe('primary');

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    expect(tried()).toEqual(['primary']);
  });

  it('removes a forbidden target, which is then never contacted', async () => {
    const { llm, probe, tried } = harness({
      rules: [{ id: 'no-primary', forbid: { name: 'primary' } }],
    });

    expect(await llm.call(call)).toBe('b');

    expect(probe.seen).toEqual([['b', 'c']]);
    expect(tried()).toEqual(['b']);
  });

  it('keeps the order the call came in with', async () => {
    const { llm, probe } = harness({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    expect(await llm.call({ ...call, targets: ['c', 'b', 'primary'] })).toBe('c');

    expect(probe.seen).toEqual([['c', 'primary']]);
  });

  it('keeps the incoming order under an allow list, whatever order the list is in', async () => {
    const { llm, probe } = harness({ rules: [{ id: 'cb', allow: { name: ['c', 'b'] } }] });

    expect(await llm.call(call)).toBe('b');

    expect(probe.seen).toEqual([['b', 'c']]);
  });

  it('unions allow rules, so each widens what the others let through', async () => {
    const { llm, probe } = harness({
      rules: [
        { id: 'only-b', allow: { name: 'b' } },
        { id: 'also-c', allow: { name: 'c' } },
      ],
    });

    await llm.call(call);

    expect(probe.seen).toEqual([['b', 'c']]);
  });

  it('applies default deny to targets no allow rule grants', async () => {
    const { llm, probe } = harness({
      default: 'deny',
      rules: [{ id: 'c-only', allow: { name: 'c' } }],
    });

    expect(await llm.call(call)).toBe('c');

    expect(probe.seen).toEqual([['c']]);
  });

  it('matches on the attributes declared for each target', async () => {
    const { llm, probe, tried } = harness({
      targets: {
        primary: { region: 'us', zdr: false },
        b: { region: 'eu', zdr: true },
        c: { region: 'eu', zdr: false },
      },
      rules: [
        {
          id: 'eu-residency',
          forbid: { not: { region: 'eu' } },
          when: { context: { region: 'eu' } },
        },
        { id: 'pii-zdr', forbid: { zdr: false }, when: { context: { data: 'pii' } } },
      ],
    });

    await llm.call({ ...call, context: { region: 'eu' } });
    await llm.call({ ...call, context: { region: 'eu', data: 'pii' } });
    await llm.call(call);

    expect(probe.seen).toEqual([['b', 'c'], ['b'], ['primary', 'b', 'c']]);
    expect(tried()).toEqual(['b', 'b', 'primary']);
  });

  it('reaches a target that declares nothing through not, and misses it with a plain match', async () => {
    const { llm, probe } = harness({
      targets: { b: { region: 'eu' } },
      rules: [
        { id: 'plain', forbid: { region: 'us' }, when: { context: { check: 'plain' } } },
        {
          id: 'inverted',
          forbid: { not: { region: 'eu' } },
          when: { context: { check: 'inverted' } },
        },
      ],
    });

    await llm.call({ ...call, context: { check: 'plain' } });
    await llm.call({ ...call, context: { check: 'inverted' } });

    // `primary` and `c` declare no region: a plain match never reaches them, `not` does.
    expect(probe.seen).toEqual([['primary', 'b', 'c'], ['b']]);
  });

  it('matches the provider only where the adapter knows it', async () => {
    const chain = targetChain();
    chain.primary.client.adapter = { name: 'openai-compatible', provider: 'openai' };
    const probe = targetProbe();
    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        policyMiddleware({
          logger: 'silent',
          rules: [{ id: 'no-openai', forbid: { provider: 'openai' } }],
        }),
        probe.middleware,
      ],
    });

    await llm.call(call);

    // `b` and `c` set no provider, so a rule on it does not reach them.
    expect(probe.seen).toEqual([['b', 'c']]);
  });

  it('warns once about a declared target that no call has', async () => {
    const log = captureLogger();
    const { llm } = harness({
      logger: log.logger,
      targets: { prymary: { region: 'eu' }, b: { region: 'eu' } },
    });

    await llm.call(call);
    await llm.call(call);

    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('"prymary"');
    expect(log.warnings()[0]).toMatch(/^\[VernLLM\] policy: /);
  });
});
