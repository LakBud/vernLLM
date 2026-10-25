import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { captureLogger, harness, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

describe('nothing gets past a rule', () => {
  it('ignores an inner middleware asking for a target policy removed', async () => {
    const log = captureLogger();
    const greedy: VernLLMMiddleware = {
      name: 'greedy',
      position: 0,
      wrap: (_request, next) => next({ targets: ['b', 'primary'] }),
    };
    const chain = targetChain();
    const llm = new VernLLM({
      ...chain.options,
      logger: log.logger,
      middleware: [
        policyMiddleware({ logger: 'silent', rules: [{ id: 'no-b', forbid: { name: 'b' } }] }),
        greedy,
      ],
    });

    expect(await llm.call(call)).toBe('primary');

    expect(chain.tried()).toEqual(['primary']);
    expect(log.warnings().some((message) => message.includes('asked for target "b"'))).toBe(true);
  });

  it('narrows a call that passes its own targets, like any other order', async () => {
    const { llm, probe, tried } = harness({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    expect(await llm.call({ ...call, targets: ['b', 'c'] })).toBe('c');

    expect(probe.seen).toEqual([['c']]);
    expect(tried()).toEqual(['c']);
  });

  it('denies a call whose own targets are all forbidden, rather than failing as no eligible target', async () => {
    const { llm, tried } = harness({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    const error = await llm.call({ ...call, targets: ['b'] }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'policy_denied', type: 'invalid_params' });
    expect(tried()).toEqual([]);
  });

  it('sees the per call model override on the primary, so a model rule cannot be dodged', async () => {
    const { llm, probe, tried } = harness({
      rules: [{ id: 'no-big', forbid: { model: 'big-model' } }],
    });

    expect(await llm.call({ ...call, model: 'big-model' })).toBe('b');
    expect(await llm.call(call)).toBe('primary');

    expect(probe.seen).toEqual([
      ['b', 'c'],
      ['primary', 'b', 'c'],
    ]);
    expect(tried()).toEqual(['b', 'primary']);
  });

  it('holds an allow list to the override too, so a model off the list is removed', async () => {
    const { llm, probe, tried } = harness({
      rules: [{ id: 'approved', allow: { model: ['primary-model', 'b-model', 'c-model'] } }],
    });

    expect(await llm.call({ ...call, model: 'unapproved-model' })).toBe('b');

    expect(probe.seen).toEqual([['b', 'c']]);
    expect(tried()).toEqual(['b']);
  });
});
