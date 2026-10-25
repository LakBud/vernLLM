import { describe, expect, it } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { captureLogger, fakeContext, gate, harness, request, until } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const params = (context?: Record<string, string>) => ({
  cacheKey: 'shared',
  ttl: 60_000,
  call: { ...call, ...(context && { context }) },
});

const swallow = (promise: Promise<unknown>) =>
  promise.then(
    (value) => value,
    (error: unknown) => error,
  );

const named = (events: { name: string }[], name: string) =>
  events.filter((event) => event.name === name);

/**
 * A harness whose primary holds its answer, so a second caller can join the first. `tried` is the
 * primary's own record, since that is the client the gate wraps.
 */
function joinable(policy: Parameters<typeof harness>[0]) {
  const base = harness();
  const { gated, release, arrived } = gate(base.chain.options.client);
  const made = harness(policy, {}, { client: gated });
  return { ...made, tried: base.tried, release, arrived };
}

const euRule = { id: 'eu-only', forbid: { name: 'primary' }, when: { context: { region: 'eu' } } };

describe('cachedCall and policy', () => {
  describe('a joiner', () => {
    it('can be denied, while the call it would have joined carries on', async () => {
      const { llm, release, arrived, events, tried } = joinable({
        rules: [{ id: 'lockout', forbid: 'all', when: { context: { status: 'suspended' } } }],
      });

      const first = llm.cachedCall(params({ status: 'active' }));
      await arrived;
      const denied = swallow(llm.cachedCall(params({ status: 'suspended' })));
      await until(() => events.length >= 2);
      release();

      expect(await first).toBe('primary');
      expect(await denied).toMatchObject({ code: 'policy_denied' });
      expect(tried()).toEqual(['primary']);
    });

    it('is decided on by its own rules, so one decision is emitted for each caller', async () => {
      const { llm, release, arrived, events } = joinable({ rules: [euRule] });

      const first = llm.cachedCall(params({ region: 'us' }));
      await arrived;
      const second = llm.cachedCall(params({ region: 'us' }));
      await until(() => named(events, 'policy.decision').length >= 2);
      release();
      await Promise.all([first, second]);

      expect(named(events, 'policy.decision')).toHaveLength(2);
      expect(named(events, 'policy.cross_join')).toEqual([]);
    });
  });

  describe('a join across rules', () => {
    it('is reported when the shared call was answered by a target the joiner may not use', async () => {
      const { llm, release, arrived, events, tried } = joinable({
        version: 'v1',
        rules: [euRule],
      });

      const first = llm.cachedCall(params({ region: 'us' }));
      await arrived;
      const joiner = llm.cachedCall(params({ region: 'eu' }));
      await until(() => named(events, 'policy.decision').length >= 2);
      release();
      await Promise.all([first, joiner]);

      expect(tried()).toEqual(['primary']);
      expect(named(events, 'policy.cross_join')).toEqual([
        {
          name: 'policy.cross_join',
          data: { v: 1, version: 'v1', target: 'primary', rule: 'eu-only' },
        },
      ]);
    });

    it('warns once per rule, however many joiners there are', async () => {
      const log = captureLogger();
      const { llm, release, arrived, events } = joinable({ logger: log.logger, rules: [euRule] });

      const first = llm.cachedCall(params({ region: 'us' }));
      await arrived;
      const joiners = [
        llm.cachedCall(params({ region: 'eu' })),
        llm.cachedCall(params({ region: 'eu' })),
      ];
      await until(() => named(events, 'policy.decision').length >= 3);
      release();
      await Promise.all([first, ...joiners]);

      expect(named(events, 'policy.cross_join')).toHaveLength(2);
      expect(log.warnings()).toEqual([
        `[VernLLM] policy: a call joined another caller's cachedCall and was answered by "primary", which rule "eu-only" removed for it. Put whatever the rules differ on in the cacheKey`,
      ]);
    });

    it('is not reported when the answering target is one the joiner may use', async () => {
      const { llm, release, arrived, events } = joinable({
        rules: [{ id: 'no-b', forbid: { name: 'b' }, when: { context: { region: 'eu' } } }],
      });

      const first = llm.cachedCall(params({ region: 'us' }));
      await arrived;
      const joiner = llm.cachedCall(params({ region: 'eu' }));
      await until(() => named(events, 'policy.decision').length >= 2);
      release();
      await Promise.all([first, joiner]);

      expect(named(events, 'policy.cross_join')).toEqual([]);
    });
  });

  describe('a call that shared nothing', () => {
    it('is not reported on a miss, even when its rules removed the answering target of another', async () => {
      const { llm, events } = harness({ rules: [euRule] });

      expect(await llm.cachedCall(params({ region: 'eu' }))).toBe('b');

      expect(named(events, 'policy.cross_join')).toEqual([]);
    });

    it('is not reported on a hit, which carries nothing to compare', async () => {
      const { llm, events } = harness({ rules: [euRule] });

      await llm.cachedCall(params({ region: 'us' }));
      await llm.cachedCall(params({ region: 'eu' }));

      expect(named(events, 'policy.decision')).toHaveLength(2);
      expect(named(events, 'policy.cross_join')).toEqual([]);
    });
  });

  describe('the target that answered', () => {
    it('is matched by its name, which is not its model, so a fallback is caught too', async () => {
      const policy = policyMiddleware({
        logger: 'silent',
        rules: [{ id: 'no-b', forbid: { name: 'b' } }],
      });
      const events: { name: string; data: unknown }[] = [];
      const meta = { provider: 'b', model: 'b-model' };

      await policy.wrap!(
        request,
        (() => Promise.resolve({ value: 'x', cache: 'join', meta })) as never,
        { ...fakeContext(), emit: (name, data) => void events.push({ name, data }) },
      );

      expect(named(events, 'policy.cross_join')).toEqual([
        { name: 'policy.cross_join', data: { v: 1, target: 'b', rule: 'no-b' } },
      ]);
    });

    it('says nothing for a model name that only looks like a removed target', async () => {
      const policy = policyMiddleware({
        logger: 'silent',
        rules: [{ id: 'no-b', forbid: { name: 'b' } }],
      });
      const events: { name: string; data: unknown }[] = [];
      const meta = { provider: 'b-model', model: 'b-model' };

      await policy.wrap!(
        request,
        (() => Promise.resolve({ value: 'x', cache: 'join', meta })) as never,
        { ...fakeContext(), emit: (name, data) => void events.push({ name, data }) },
      );

      expect(named(events, 'policy.cross_join')).toEqual([]);
    });
  });
});
