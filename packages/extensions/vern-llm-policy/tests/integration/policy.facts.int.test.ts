import { describe, expect, it, vi } from 'vitest';

import { policyMiddleware, type PolicyRule } from '../../src/index.js';
import { fakeContext, harness, request } from '../helpers.js';

import type { CallResult } from 'vern-llm';

const call = { userContent: 'hi', jsonMode: false as const };

/** A rule that removes the primary when `when` holds, so the answer shows whether it did. */
const noPrimaryWhen = (when: PolicyRule['when']): PolicyRule => ({
  id: 'no-primary',
  forbid: { name: 'primary' },
  when,
});

/** Which target answered a call: `primary` when the rule did not apply, `b` when it did. */
async function answeredBy(when: PolicyRule['when'], params: Record<string, unknown> = {}) {
  const { llm } = harness(
    { rules: [noPrimaryWhen(when)] },
    {
      primary: [{ choices: [{ message: { content: '{"who":"primary"}' } }] }],
      b: [{ choices: [{ message: { content: '{"who":"b"}' } }] }],
    },
  );
  const answer = await llm.call({ ...call, jsonMode: true, ...params });
  return (answer as { who: string }).who;
}

describe('the call facts a rule can read', () => {
  describe('context', () => {
    it('matches a value, and not a different one or none at all', async () => {
      const when = { context: { plan: 'free' } };

      expect(await answeredBy(when, { context: { plan: 'free' } })).toBe('b');
      expect(await answeredBy(when, { context: { plan: 'pro' } })).toBe('primary');
      expect(await answeredBy(when)).toBe('primary');
    });

    it('reaches a call with no context through not', async () => {
      const when = { context: { not: { plan: 'pro' } } };

      expect(await answeredBy(when)).toBe('b');
      expect(await answeredBy(when, { context: { plan: 'pro' } })).toBe('primary');
    });
  });

  describe('request', () => {
    it('knows whether the call has tools', async () => {
      const tool = {
        name: 'lookup',
        description: 'Looks something up',
        parameters: { type: 'object' },
      };
      const rules = [noPrimaryWhen({ request: { hasTools: true } })];

      // A call with tools does not return plain content, so read who was contacted instead.
      const withTools = harness({ rules });
      await withTools.llm.call({ ...call, tools: [tool] });
      expect(withTools.tried()).toEqual(['b']);

      const without = harness({ rules });
      await without.llm.call(call);
      expect(without.tried()).toEqual(['primary']);
    });

    it('knows whether the call wants JSON', async () => {
      expect(await answeredBy({ request: { jsonOutput: true } })).toBe('b');

      const { llm, tried } = harness({ rules: [noPrimaryWhen({ request: { jsonOutput: true } })] });
      await llm.call(call);
      expect(tried()).toEqual(['primary']);
    });

    it('knows whether the call carries an image', async () => {
      const image = [
        { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' },
        { type: 'text' as const, text: 'what is this' },
      ];

      expect(await answeredBy({ request: { images: true } }, { userContent: image })).toBe('b');
      expect(await answeredBy({ request: { images: true } })).toBe('primary');
    });

    it('estimates the input tokens, leaving out the room kept for the reply', async () => {
      const when = { request: { inputTokens: { gte: 1_000 } } };

      expect(await answeredBy(when, { userContent: 'x'.repeat(8_000) })).toBe('b');
      // A short prompt stays under the bound however large `maxTokens` is.
      expect(await answeredBy(when, { maxTokens: 50_000 })).toBe('primary');
    });

    it('knows whether the call streams', async () => {
      const wrap = policyMiddleware({
        logger: 'silent',
        rules: [{ id: 'no-b', forbid: { name: 'b' }, when: { request: { streaming: true } } }],
      }).wrap!;
      const next = vi.fn(async (): Promise<CallResult> => ({ value: 'ok' }));

      await wrap(request, next, fakeContext({ streaming: true }));
      await wrap(request, next, fakeContext({ streaming: false }));
      await wrap(request, next, fakeContext());

      expect(next.mock.calls).toEqual([[{ targets: ['primary', 'c'] }], [], []]);
    });
  });

  describe('callTargets', () => {
    it('knows whether the call chose its own targets', async () => {
      const when = { callTargets: true };

      expect(await answeredBy(when, { targets: ['primary', 'b'] })).toBe('b');
      expect(await answeredBy(when)).toBe('primary');
    });
  });

  describe('a function', () => {
    it('reads every fact', async () => {
      const when = (facts: {
        context?: { plan?: string };
        request: { hasTools: boolean; inputTokens: number };
        callTargets: boolean;
      }) =>
        facts.context?.plan === 'free' && !facts.request.hasTools && facts.request.inputTokens > 0;

      expect(await answeredBy(when, { context: { plan: 'free' } })).toBe('b');
      expect(await answeredBy(when, { context: { plan: 'pro' } })).toBe('primary');
    });
  });

  describe('several facts', () => {
    it('all have to hold', async () => {
      const when = { context: { plan: 'free' }, request: { jsonOutput: true } };

      expect(await answeredBy(when, { context: { plan: 'free' } })).toBe('b');
      expect(await answeredBy(when, { context: { plan: 'pro' } })).toBe('primary');
    });

    it('can be any of', async () => {
      const when = { any: [{ context: { plan: 'free' } }, { callTargets: true }] };

      expect(await answeredBy(when, { context: { plan: 'free' } })).toBe('b');
      expect(await answeredBy(when, { targets: ['primary', 'b'] })).toBe('b');
      expect(await answeredBy(when, { context: { plan: 'pro' } })).toBe('primary');
    });
  });
});
