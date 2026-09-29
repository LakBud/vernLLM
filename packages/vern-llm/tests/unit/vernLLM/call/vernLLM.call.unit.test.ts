import { describe, expect, it, vi } from 'vitest';

import {
  createStateKey,
  LLMError,
  stateEntry,
  type VernLLMMiddleware,
} from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, createMockClient, jsonResponse, textResponse } from '../../../helpers.js';

describe('VernLLM.call: happy paths', () => {
  it('returns parsed JSON by default', async () => {
    const { client } = createMockClient([jsonResponse({ hello: 'world' })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ systemPrompt: 'sys', userContent: 'usr' });
    expect(result).toEqual({ hello: 'world' });
  });

  it('returns raw string when jsonMode is false, skipping JSON parsing entirely', async () => {
    const { client } = createMockClient([textResponse('not json at all {{{')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      systemPrompt: 'sys',
      userContent: 'usr',
      jsonMode: false,
    });
    expect(result).toBe('not json at all {{{');
  });

  it('omits the system message entirely when systemPrompt is not provided', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({ userContent: 'usr' });

    expect(calls[0]).toMatchObject({
      messages: [{ role: 'user', content: 'usr' }],
    });
  });

  it('sends model, temperature, max_tokens, and messages correctly', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model', defaultMaxTokens: 500 });

    await llm.call({
      systemPrompt: 'system text',
      userContent: 'user text',
      temperature: 0.7,
    });

    expect(calls[0]).toMatchObject({
      model: 'default-model',
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
    });
  });

  it('defaults to json_object response_format when jsonMode is true', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(at(calls, 0).response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when jsonMode is false', async () => {
    const { client, calls } = createMockClient([textResponse('plain text')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', jsonMode: false });
    expect(at(calls, 0).response_format).toBeUndefined();
  });
});

describe('VernLLM.call, temperature', () => {
  it('sends 0.2 when neither a per-call nor instance-level temperature is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).temperature).toBe(0.2);
  });

  it('a per-call number overrides the 0.2 default', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u', temperature: 0.9 });
    expect(at(calls, 0).temperature).toBe(0.9);
  });

  it('a per-call null omits temperature from the request entirely', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u', temperature: null });
    expect('temperature' in at(calls, 0)).toBe(false);
  });

  it('falls back to an instance-level defaultTemperature when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: 0.5 });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).temperature).toBe(0.5);
  });

  it('an instance-level defaultTemperature: null omits temperature when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: null });

    await llm.call({ userContent: 'u' });
    expect('temperature' in at(calls, 0)).toBe(false);
  });

  it('a per-call value always wins over an instance-level defaultTemperature, in both directions', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: null });

    // per-call number overrides an instance-level null opt-out
    await llm.call({ userContent: 'u', temperature: 0.3 });
    expect(at(calls, 0).temperature).toBe(0.3);

    // per-call null opts out even when the instance default is a number
    const llm2 = new VernLLM({ client, model: 'm', defaultTemperature: 0.8 });
    await llm2.call({ userContent: 'u', temperature: null });
    expect('temperature' in at(calls, 1)).toBe(false);
  });

  it('treats temperature: 0 as a real value, not as unset', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({ client, model: 'm' });
    await llm.call({ userContent: 'u', temperature: 0 });
    expect(at(calls, 0).temperature).toBe(0);

    const llmWithZeroDefault = new VernLLM({ client, model: 'm', defaultTemperature: 0 });
    await llmWithZeroDefault.call({ userContent: 'u' });
    expect(at(calls, 1).temperature).toBe(0);
  });
});

describe('VernLLM.call, reasoning defaults', () => {
  it('falls back to an instance-level defaultReasoningEffort when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultReasoningEffort: 'high' });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).reasoning_effort).toBe('high');
  });

  it('falls back to an instance-level defaultBudgetTokens when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultBudgetTokens: 12000 });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).budget_tokens).toBe(12000);
  });

  it('a per-call reasoningEffort/budgetTokens always wins over its instance-level default', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      defaultReasoningEffort: 'low',
      defaultBudgetTokens: 4096,
    });

    await llm.call({ userContent: 'u', reasoningEffort: 'high', budgetTokens: 32000 });
    expect(at(calls, 0).reasoning_effort).toBe('high');
    expect(at(calls, 0).budget_tokens).toBe(32000);
  });

  it('a fallback target without its own reasoning defaults inherits the primary-resolved ones', async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient, calls: fallbackCalls } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      defaultReasoningEffort: 'medium',
      defaultBudgetTokens: 16000,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await llm.call({ userContent: 'u' });
    expect(at(fallbackCalls, 0).reasoning_effort).toBe('medium');
    expect(at(fallbackCalls, 0).budget_tokens).toBe(16000);
  });

  it("a fallback target's own reasoning defaults override the primary's, same as defaultTemperature does", async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient, calls: fallbackCalls } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      defaultReasoningEffort: 'medium',
      defaultBudgetTokens: 16000,
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        defaultReasoningEffort: 'minimal',
        defaultBudgetTokens: 1024,
      },
    });

    await llm.call({ userContent: 'u' });
    expect(at(fallbackCalls, 0).reasoning_effort).toBe('minimal');
    expect(at(fallbackCalls, 0).budget_tokens).toBe(1024);
  });

  it('reasoningEffort: null opts a call out of an instance-level defaultReasoningEffort, mirroring temperature: null', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultReasoningEffort: 'high' });

    await llm.call({ userContent: 'u', reasoningEffort: null });
    expect('reasoning_effort' in at(calls, 0)).toBe(false);
  });

  it('budgetTokens: null opts a call out of an instance-level defaultBudgetTokens, mirroring temperature: null', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultBudgetTokens: 12000 });

    await llm.call({ userContent: 'u', budgetTokens: null });
    expect('budget_tokens' in at(calls, 0)).toBe(false);
  });

  it('reasoningEffort/budgetTokens: null only affects the one call they are passed to, not later calls on the same instance', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      defaultReasoningEffort: 'high',
      defaultBudgetTokens: 12000,
    });

    await llm.call({ userContent: 'u', reasoningEffort: null, budgetTokens: null });
    expect('reasoning_effort' in at(calls, 0)).toBe(false);
    expect('budget_tokens' in at(calls, 0)).toBe(false);

    await llm.call({ userContent: 'u' });
    expect(at(calls, 1).reasoning_effort).toBe('high');
    expect(at(calls, 1).budget_tokens).toBe(12000);
  });
});

describe('VernLLM.call, parse failures', () => {
  it('throws LLMError(parse) on invalid JSON and does not retry', async () => {
    const { client, create } = createMockClient([textResponse('{not valid json')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'parse',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws LLMError(api) on an empty response', async () => {
    const { client } = createMockClient([{ choices: [{ message: { content: '' } }] }]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'api',
    });
  });
});

describe('LLMError', () => {
  it('carries type, status, and issues', () => {
    const err = new LLMError('boom', 'validation', { issues: { field: 'name' } });
    expect(err.type).toBe('validation');
    expect(err.issues).toEqual({ field: 'name' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('VernLLM.call, timeout handling', () => {
  it('throws LLMError(timeout) when an internal timeout aborts the request', async () => {
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      timeoutMs: 10,
      maxRetries: 0,
    });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'timeout',
    });

    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call, context', () => {
  const call = { userContent: 'hi', jsonMode: false as const };

  function spied() {
    const hook = vi.fn();
    const middleware: VernLLMMiddleware = {
      name: 'spy',
      enabled: () => {
        hook('enabled');
        return true;
      },
      wrap: async (_request, next) => {
        hook('wrap');
        return next();
      },
      transform: () => {
        hook('transform');
        return {};
      },
      dispatch: async (_request, next) => {
        hook('dispatch');
        await next();
      },
      onEvent: () => hook('onEvent'),
    };

    return { hook, middleware };
  }

  it.each([
    ['null', null],
    ['an array', [1]],
    ['a string', 'tenant'],
    ['a class instance', new (class Tenant {})()],
    ['a function value', { a: () => 1 }],
    ['an undefined value', { a: undefined }],
    ['NaN', { a: Number.NaN }],
  ])('rejects %s before any hook runs or any request is sent', async (_label, context) => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const { hook, middleware } = spied();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    const rejection = llm.call({ ...call, context: context as never });

    await expect(rejection).rejects.toBeInstanceOf(LLMError);
    await expect(rejection).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'invalid_context',
      retryable: false,
    });
    expect(hook).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a cyclic context before any hook runs', async () => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const { hook, middleware } = spied();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(llm.call({ ...call, context: cyclic as never })).rejects.toMatchObject({
      code: 'invalid_context',
    });
    expect(hook).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('gives a stream call the same rejection, before it opens anything', async () => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ ...call, stream: true, context: 5 as never })).rejects.toMatchObject({
      code: 'invalid_context',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts an empty context and none at all', async () => {
    const { client } = createMockClient([textResponse('a'), textResponse('b')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ ...call, context: {} })).resolves.toBe('a');
    await expect(llm.call(call)).resolves.toBe('b');
  });

  it('shows middleware a frozen copy, so mutating either side cannot change the other', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const seen: unknown[] = [];
    const original = { tenantId: 't1', nested: { n: 1 } };
    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [
        {
          name: 'reader',
          wrap: async (_request, next, ctx) => {
            original.tenantId = 'changed mid call';
            seen.push(
              ctx.context,
              Object.isFrozen(ctx.context),
              Object.isFrozen(ctx.context?.nested),
            );
            expect(() => {
              (ctx.context as { tenantId: string }).tenantId = 'x';
            }).toThrow(TypeError);
            return next();
          },
        },
      ],
    });

    await llm.call({ ...call, context: original });

    expect(seen).toEqual([{ tenantId: 't1', nested: { n: 1 } }, true, true]);
    expect(original.tenantId).toBe('changed mid call');
  });

  it('never sends context to the provider', async () => {
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({ ...call, context: { tenantId: 'secret-tenant', routing: { only: ['x'] } } });

    expect(JSON.stringify(calls[0])).not.toContain('secret-tenant');
    expect(calls[0]).not.toHaveProperty('context');
  });

  it('leaves ctx.context undefined when the call gave none', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const seen: unknown[] = [];
    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [
        {
          name: 'reader',
          wrap: async (_request, next, ctx) => {
            seen.push(ctx.context);
            return next();
          },
        },
      ],
    });

    await llm.call(call);

    expect(seen).toEqual([undefined]);
  });
});

describe('VernLLM.call, state', () => {
  const call = { userContent: 'hi', jsonMode: false as const };
  const key = createStateKey<string>('test.key');

  function spied() {
    const hook = vi.fn();
    const middleware: VernLLMMiddleware = {
      name: 'spy',
      enabled: () => {
        hook('enabled');
        return true;
      },
      wrap: async (_request, next) => {
        hook('wrap');
        return next();
      },
      transform: () => {
        hook('transform');
        return {};
      },
      dispatch: async (_request, next) => {
        hook('dispatch');
        await next();
      },
      onEvent: () => hook('onEvent'),
    };

    return { hook, middleware };
  }

  it.each([
    ['null', null],
    ['an object', {}],
    ['a string', 'state'],
    ['an entry that is not an array', [key]],
    ['an entry with one item', [[key]]],
    ['an entry with three items', [[key, 'a', 'b']]],
    ['a string key', [['tenant', 'a']]],
    ['a null key', [[null, 'a']]],
    ['a plain object key', [[{}, 'a']]],
    ['a key with a non string debugName', [[{ debugName: 1 }, 'a']]],
    ['a class instance key', [[new Date(), 'a']]],
  ])('rejects %s before any hook runs or any request is sent', async (_label, state) => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const { hook, middleware } = spied();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    const rejection = llm.call({ ...call, state: state as never });

    await expect(rejection).rejects.toBeInstanceOf(LLMError);
    await expect(rejection).rejects.toMatchObject({
      type: 'invalid_params',
      message: expect.stringContaining('`state`'),
      retryable: false,
    });
    expect(hook).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('gives a stream call the same rejection, before it opens anything', async () => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ ...call, stream: true, state: 5 as never })).rejects.toMatchObject({
      type: 'invalid_params',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts an empty state and none at all', async () => {
    const { client } = createMockClient([textResponse('a'), textResponse('b')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(llm.call({ ...call, state: [] })).resolves.toBe('a');
    await expect(llm.call(call)).resolves.toBe('b');
  });

  it('runs every hook once the state is valid', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const { hook, middleware } = spied();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    await llm.call({ ...call, state: [stateEntry(key, 'v')] });

    expect(hook).toHaveBeenCalledWith('wrap');
    expect(hook).toHaveBeenCalledWith('transform');
  });
});
