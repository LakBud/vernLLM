import { describe, expect, it } from 'vitest';

import { LLMError } from '../../../../src/types/index.js';
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
