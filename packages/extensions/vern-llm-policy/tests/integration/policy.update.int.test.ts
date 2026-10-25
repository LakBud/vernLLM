import { describe, expect, it } from 'vitest';

import { captureLogger, gate, harness } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const versions = (events: { data: unknown }[]) =>
  events.map((event) => (event.data as { version?: string }).version);

describe('update', () => {
  it('applies to the next call', async () => {
    const { llm, policy, probe } = harness({ version: 'v1', rules: [] });

    await llm.call(call);
    policy.update({ version: 'v2', rules: [{ id: 'no-b', forbid: { name: 'b' } }] });
    await llm.call(call);

    expect(probe.seen).toEqual([
      ['primary', 'b', 'c'],
      ['primary', 'c'],
    ]);
  });

  it('stamps every decision with the version that made it', async () => {
    const { llm, policy, events } = harness({ version: 'v1' });

    await llm.call(call);
    policy.update({ version: 'v2' });
    await llm.call(call);
    policy.update({});
    await llm.call(call);

    expect(versions(events)).toEqual(['v1', 'v2', undefined]);
  });

  it('leaves a call already under way on the policy it started with', async () => {
    const rules = [{ id: 'no-b', forbid: { name: 'b' } }];
    const { gated, release, arrived } = gate(harness().chain.options.client);
    const { llm, policy, probe, events } = harness({ version: 'v1', rules }, {}, { client: gated });

    const inFlight = llm.call(call);
    await arrived;
    policy.update({ version: 'v2', rules: [{ id: 'no-c', forbid: { name: 'c' } }] });
    const after = llm.call(call);
    release();
    await Promise.all([inFlight, after]);

    // The first call decided before the swap, the second after it, and neither saw both.
    expect(probe.seen).toEqual([
      ['primary', 'c'],
      ['primary', 'b'],
    ]);
    expect(versions(events)).toEqual(['v1', 'v2']);
  });

  it('keeps every decision whole under a burst of swaps and calls', async () => {
    const { llm, policy, probe, events } = harness({ version: 'v0' });
    const rulesFor = (n: number) =>
      n % 2 === 0
        ? [{ id: 'no-b', forbid: { name: 'b' } }]
        : [{ id: 'no-c', forbid: { name: 'c' } }];

    const calls: Promise<unknown>[] = [];
    for (let n = 1; n <= 20; n++) {
      policy.update({ version: `v${n}`, rules: rulesFor(n) });
      calls.push(llm.call(call), llm.call(call));
    }
    await Promise.all(calls);

    expect(events).toHaveLength(40);
    events.forEach((event, i) => {
      const { version, removed } = event.data as { version: string; removed: object };
      const n = Number(version.slice(1));
      // Whatever version stamped the decision is the one whose rules removed the target.
      expect(removed).toEqual(n % 2 === 0 ? { b: 'no-b' } : { c: 'no-c' });
      expect(probe.seen[i]).toEqual(n % 2 === 0 ? ['primary', 'c'] : ['primary', 'b']);
    });
  });

  describe('with a mistake in it', () => {
    it('throws, and the old policy keeps deciding', async () => {
      const { llm, policy, probe, events } = harness({
        version: 'v1',
        rules: [{ id: 'no-b', forbid: { name: 'b' } }],
      });

      expect(() =>
        policy.update({
          version: 'v2',
          rules: [
            { id: 'a', forbid: 'all' },
            { id: 'a', forbid: 'all' },
          ],
        }),
      ).toThrow('rules[1].id "a" is used by another rule');
      await llm.call(call);

      expect(probe.seen).toEqual([['primary', 'c']]);
      expect(versions(events)).toEqual(['v1']);
    });

    it.each([
      ['an attribute no target declares', { rules: [{ id: 'a', forbid: { regoin: 'eu' } }] }],
      ['a rule with no effect', { rules: [{ id: 'a' }] }],
      ['an unknown option', { rulez: [] }],
    ])('rejects %s', (_name, update) => {
      const { policy } = harness();
      expect(() => policy.update(update as never)).toThrow('policyMiddleware:');
    });

    it('refuses to change the logger', () => {
      const { policy } = harness();
      expect(() => policy.update({ logger: 'silent' } as never)).toThrow(
        'policyMiddleware: update cannot change the logger',
      );
    });
  });

  describe('replaces the policy as a whole', () => {
    it('drops what the update leaves out', async () => {
      const { llm, policy, probe } = harness({
        default: 'deny',
        rules: [{ id: 'all', allow: { name: ['primary', 'b', 'c'] } }],
      });

      policy.update({});
      await llm.call(call);

      expect(probe.seen).toEqual([['primary', 'b', 'c']]);
    });

    it('takes new targets along with rules that need them', async () => {
      const { llm, policy, probe } = harness();

      policy.update({
        targets: { b: { region: 'eu' }, c: { region: 'us' } },
        rules: [{ id: 'eu-only', allow: { region: 'eu' } }],
      });
      await llm.call(call);

      expect(probe.seen).toEqual([['b']]);
    });

    it('checks the new target names against the next call, and warns once', async () => {
      const log = captureLogger();
      const { llm, policy } = harness({ logger: log.logger });

      policy.update({ targets: { nope: { region: 'eu' } } });
      await llm.call(call);
      await llm.call(call);

      expect(log.warnings()).toEqual([
        '[VernLLM] policy: targets declares "nope", but no target of the first call has that name, so its attributes are never used',
      ]);
    });

    it('warns again about a rule that throws, since it is a new policy', async () => {
      const log = captureLogger();
      const broken = {
        id: 'broken',
        forbid: { name: 'b' },
        when: () => {
          throw new Error('boom');
        },
      };
      const { llm, policy } = harness({ logger: log.logger, rules: [broken] });

      await llm.call(call);
      await llm.call(call);
      policy.update({ rules: [broken] });
      await llm.call(call);

      expect(log.warnings()).toHaveLength(2);
    });
  });
});
