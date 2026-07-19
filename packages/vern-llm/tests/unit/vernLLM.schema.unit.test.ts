import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

describe('VernLLM.call — Zod schema validation', () => {
  const Schema = z.object({ name: z.string(), skills: z.array(z.string()) });

  it('returns typed, validated data on a matching schema', async () => {
    const { client } = createMockClient([jsonResponse({ name: 'Fammy', skills: ['ts', 'node'] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({ systemPrompt: 's', userContent: 'u', schema: Schema });
    expect(result).toEqual({ name: 'Fammy', skills: ['ts', 'node'] });
  });

  it('throws LLMError(validation) with issues on a schema mismatch, without retrying', async () => {
    const { client, create } = createMockClient([jsonResponse({ wrong: 'shape' })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    const err = await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: Schema })
      .catch((e) => e);

    expect(err.type).toBe('validation');
    expect(err.issues).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call — provider-native jsonSchema mode', () => {
  it('sends response_format: json_schema with the given spec', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonSchema: {
        name: 'Result',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });

    expect(calls[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Result',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        strict: true,
        description: undefined,
      },
    });
  });

  it('respects an explicit strict: false', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonSchema: { name: 'R', schema: {}, strict: false },
    });

    expect(calls[0].response_format).toMatchObject({ json_schema: { strict: false } });
  });

  it('implies JSON mode even without jsonMode explicitly set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonSchema: { name: 'R', schema: {} },
    });

    expect(calls[0].response_format?.type).toBe('json_schema');
    expect(result).toEqual({ ok: true }); // parsed, not raw string
  });

  it('combines with a Zod schema for client-side validation on top', async () => {
    const Schema = z.object({ ok: z.boolean() });
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonSchema: { name: 'R', schema: {} },
      schema: Schema,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe('VernLLM.call — per-call model override and reasoningEffort', () => {
  it('uses the instance default model when not overridden', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(calls[0].model).toBe('default-model');
  });

  it('overrides the model for a single call', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u', model: 'override-model' });
    expect(calls[0].model).toBe('override-model');
  });

  it('does not leak a per-call model override into subsequent calls', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u', model: 'override-model' });
    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(calls[0].model).toBe('override-model');
    expect(calls[1].model).toBe('default-model');
  });

  it('passes reasoning_effort through when set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', reasoningEffort: 'high' });
    expect(calls[0].reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when not set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(calls[0].reasoning_effort).toBeUndefined();
  });
});

describe('VernLLM.call — usage tracking', () => {
  it('invokes onUsage with mapped token counts and resolved model after success', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ]);
    const llm = new VernLLM({ client, model: 'default-model', onUsage });

    await llm.call({ systemPrompt: 's', userContent: 'u', model: 'override-model' });

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        model: 'override-model',
      }),
    );
  });

  it('does not call onUsage when the provider reports no usage', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', onUsage });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does not call onUsage on a failed call', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([new Error('boom')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsage });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(onUsage).not.toHaveBeenCalled();
  });
});
