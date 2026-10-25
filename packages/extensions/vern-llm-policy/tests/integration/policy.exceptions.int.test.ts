import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { captureLogger, harness } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const euOnly = {
  id: 'eu-residency',
  forbid: { name: 'primary' },
  except: [
    {
      when: { context: { tenant: 'acme' } },
      until: '2026-11-01',
      reason: 'DPA signed, migration pending',
    },
  ],
};

beforeEach(() => {
  // Only the clock: retries and the like keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an exception in a real call', () => {
  it('lets the covered tenant use the target, and records why', async () => {
    const { llm, probe, events } = harness({ rules: [euOnly] });

    await llm.call({ ...call, context: { tenant: 'acme' } });

    expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    expect(events[0]!.data).toMatchObject({
      removed: {},
      exceptions: [
        { rule: 'eu-residency', reason: 'DPA signed, migration pending', until: '2026-11-01' },
      ],
    });
  });

  it('keeps the rule for everyone else', async () => {
    const { llm, probe, events } = harness({ rules: [euOnly] });

    await llm.call({ ...call, context: { tenant: 'other' } });

    expect(probe.seen).toEqual([['b', 'c']]);
    expect(events[0]!.data).toMatchObject({ removed: { primary: 'eu-residency' }, exceptions: [] });
  });

  it('stops covering the tenant on the day it ends, with no change to the policy', async () => {
    const log = captureLogger();
    const { llm, probe } = harness({ logger: log.logger, rules: [euOnly] });

    await llm.call({ ...call, context: { tenant: 'acme' } });
    vi.setSystemTime(new Date('2026-10-31T23:59:59.999Z'));
    await llm.call({ ...call, context: { tenant: 'acme' } });
    expect(log.warnings()).toEqual([]);

    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    await llm.call({ ...call, context: { tenant: 'acme' } });
    await llm.call({ ...call, context: { tenant: 'acme' } });

    expect(probe.seen).toEqual([
      ['primary', 'b', 'c'],
      ['primary', 'b', 'c'],
      ['b', 'c'],
      ['b', 'c'],
    ]);
    expect(log.warnings()).toEqual([
      '[VernLLM] policy: rule "eu-residency" has an exception that ended on 2026-11-01 ("DPA signed, migration pending"), so it no longer applies',
    ]);
  });

  it('warns when the policy is built with an exception that has already ended', () => {
    const log = captureLogger();
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));

    policyMiddleware({ logger: log.logger, rules: [euOnly] });

    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('ended on 2026-11-01');
  });

  it('stays quiet about an exception that has not ended', () => {
    const log = captureLogger();

    policyMiddleware({ logger: log.logger, rules: [euOnly] });

    expect(log.warnings()).toEqual([]);
  });
});
