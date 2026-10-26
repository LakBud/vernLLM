import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import { captureLogger, eventProbe, serverError, settle, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const budget = { ratio: 1, burst: 1 };

function setup(options: HedgeOptions, entries: Parameters<typeof targetChain>[0] = {}) {
  const chain = targetChain(entries);
  const probe = eventProbe('hedge.decision');
  const logs = captureLogger();
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ logger: logs.logger, budget, ...options }),
    ],
  });
  return { llm, chain, logs, events: probe.events as Record<string, unknown>[] };
}

describe('each skip reason', () => {
  it.each([
    ['no_target', { delay: 20, targets: () => [] }, call],
    ['not_allowed', { delay: 20, when: () => false }, call],
    ['no_data', { stats: { quantile: () => undefined } }, call],
    ['deadline', { delay: 500 }, { ...call, deadlineMs: 100 }],
  ] as const)('%s runs the call as it is, and reports why', async (outcome, options, params) => {
    const { llm, chain, events } = setup(options as HedgeOptions);

    expect(await llm.call(params)).toBe('primary');
    await settle(30);

    expect(chain.tried()).toEqual(['primary']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ v: 1, outcome });
  });

  it('reports the delay with a deadline skip, and none for a skip before it was computed', async () => {
    const deadline = setup({ delay: 500 });
    await deadline.llm.call({ ...call, deadlineMs: 100 });

    const noTarget = setup({ delay: 500, targets: () => [] });
    await noTarget.llm.call(call);

    expect(deadline.events[0]).toEqual({ v: 1, outcome: 'deadline', delayMs: 500 });
    expect(noTarget.events[0]).toEqual({ v: 1, outcome: 'no_target' });
  });

  it('does not skip a call whose deadline is further away than the delay', async () => {
    const { llm, events } = setup({ delay: 20 });

    await llm.call({ ...call, deadlineMs: 5_000 });

    expect(events[0]).toMatchObject({ outcome: 'not_needed' });
  });
});

describe('a skipped call', () => {
  const scenarios = {
    'answers from the fallback': { primary: [serverError()] },
    'fails everywhere': { primary: [serverError()], b: [serverError()], c: [serverError()] },
  };

  it.each(Object.entries(scenarios))(
    'behaves exactly as without the hedge when it %s',
    async (_name, entries) => {
      const plain = targetChain(entries);
      const plainLLM = new VernLLM({ ...plain.options });
      const hedged = setup({ delay: 20, when: () => false }, entries);

      const outcome = async (llm: VernLLM) =>
        llm.call(call).then(
          (value) => ({ value }),
          (error: Error & { code?: string }) => ({ name: error.name, code: error.code }),
        );

      expect(await outcome(hedged.llm)).toEqual(await outcome(plainLLM));
      expect(hedged.chain.tried()).toEqual(plain.tried());
    },
  );
});

describe('a bug in an option', () => {
  it('skips a call whose targets throws, and logs it', async () => {
    const { llm, chain, logs, events } = setup({
      delay: 20,
      targets: () => {
        throw new Error('bad targets');
      },
    });

    expect(await llm.call(call)).toBe('primary');

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ outcome: 'no_target' });
    expect(logs.errors()).toHaveLength(1);
  });

  it('skips a call whose targets returns something other than a list, and warns once', async () => {
    const { llm, logs, events } = setup({ delay: 20, targets: () => 'b' as never });

    await llm.call(call);
    await llm.call(call);

    expect(events.map((event) => event.outcome)).toEqual(['no_target', 'no_target']);
    expect(logs.warnings()).toHaveLength(1);
  });

  it('skips a call whose when throws, and logs it', async () => {
    const { llm, chain, logs, events } = setup({
      delay: 20,
      when: () => {
        throw new Error('bad when');
      },
    });

    expect(await llm.call(call)).toBe('primary');

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ outcome: 'not_allowed' });
    expect(logs.errors()).toHaveLength(1);
  });

  it('skips a call whose delay function throws, and logs it', async () => {
    const { llm, logs, events } = setup({
      delay: () => {
        throw new Error('bad delay');
      },
    });

    await llm.call(call);

    expect(events[0]).toMatchObject({ outcome: 'no_data' });
    expect(logs.errors()).toHaveLength(1);
  });

  it('never lets a failing logger break the call', async () => {
    const chain = targetChain();
    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        hedgeMiddleware({
          delay: 20,
          targets: () => {
            throw new Error('bad targets');
          },
          logger: {
            debug: () => {},
            warn: () => {},
            error: () => {
              throw new Error('logger is broken');
            },
          },
        }),
      ],
    });

    expect(await llm.call(call)).toBe('primary');
  });
});
