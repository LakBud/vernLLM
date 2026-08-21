import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { LLMError } from '../../src/types/errors.js';
import { VernLLM } from '../../src/vernLLM.js';
import { at, createMockClient, jsonResponse } from '../helpers.js';

describe('VernLLM.call, Zod schema validation', () => {
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

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: Schema })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('validation');
    expect(err.issues).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws LLMError(invalid_params) instead of silently skipping when schema is combined with jsonMode: false', async () => {
    const { client, create } = createMockClient([jsonResponse({ name: 'Fammy', skills: [] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: Schema, jsonMode: false })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('invalid_params');
    expect(err.message).toMatch(/nothing would validate it/);
    expect(create).not.toHaveBeenCalled();
  });

  it('still validates when jsonMode: false is combined with jsonSchema (JSON parsing enabled via jsonSchema)', async () => {
    const { client } = createMockClient([jsonResponse({ name: 'Fammy', skills: ['ts'] })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      schema: Schema,
      jsonMode: false,
      jsonSchema: { name: 'R', schema: {} },
    });

    expect(result).toEqual({ name: 'Fammy', skills: ['ts'] });
  });
});

describe('VernLLM.call, provider-native jsonSchema mode', () => {
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

    expect(at(calls, 0).response_format).toEqual({
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

    expect(at(calls, 0).response_format).toMatchObject({ json_schema: { strict: false } });
  });

  it('implies JSON mode even without jsonMode explicitly set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      jsonSchema: { name: 'R', schema: {} },
    });

    expect(at(calls, 0).response_format?.type).toBe('json_schema');
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

describe('VernLLM.call, per-call model override and reasoningEffort', () => {
  it('uses the instance default model when not overridden', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(at(calls, 0).model).toBe('default-model');
  });

  it('overrides the model for a single call', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u', model: 'override-model' });
    expect(at(calls, 0).model).toBe('override-model');
  });

  it('does not leak a per-call model override into subsequent calls', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'default-model' });

    await llm.call({ systemPrompt: 's', userContent: 'u', model: 'override-model' });
    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(at(calls, 0).model).toBe('override-model');
    expect(at(calls, 1).model).toBe('default-model');
  });

  it('passes reasoning_effort through when set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', reasoningEffort: 'high' });
    expect(at(calls, 0).reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when not set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(at(calls, 0).reasoning_effort).toBeUndefined();
  });
});

describe('VernLLM.call, usage tracking', () => {
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

  it('invokes onUsage with reasoningTokens when the provider reports a reasoning breakdown', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([
      jsonResponse(
        { ok: true },
        {
          prompt_tokens: 10,
          completion_tokens: 50,
          total_tokens: 60,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      ),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage });

    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 50, reasoningTokens: 30 }),
    );
  });

  it('omits reasoningTokens from onUsage when the provider reports no reasoning breakdown', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage });

    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(onUsage.mock.calls[0]![0].reasoningTokens).toBeUndefined();
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

  it('swallows a throwing onUsage callback instead of failing the call or triggering a retry', async () => {
    const onUsage = vi.fn(() => {
      throw new Error('onUsage boom');
    });
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage });

    const result = await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(result).toEqual({ ok: true });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // no retry triggered by the callback's own failure
  });
});

describe('VernLLM.call, onUsageFailure', () => {
  it('fires onUsageFailure with the spent usage and a validation error, without also firing onUsage', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([
      jsonResponse(
        { wrong: 'shape' },
        { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      ),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage, onUsageFailure });

    const err = (await llm
      .call({
        systemPrompt: 's',
        userContent: 'u',
        schema: z.object({ name: z.string() }),
      })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('validation');
    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 12, completionTokens: 8, totalTokens: 20 }),
      expect.objectContaining({ type: 'validation' }),
    );
  });

  it('fires onUsageFailure with reasoningTokens carried through, not just completionTokens', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([
      jsonResponse(
        { wrong: 'shape' },
        {
          prompt_tokens: 12,
          completion_tokens: 50,
          total_tokens: 62,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      ),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage, onUsageFailure });

    await llm
      .call({
        systemPrompt: 's',
        userContent: 'u',
        schema: z.object({ name: z.string() }),
      })
      .catch(() => {});

    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ completionTokens: 50, reasoningTokens: 30 }),
      expect.objectContaining({ type: 'validation' }),
    );
  });

  it('fires onUsageFailure with a parse error when usage survived a malformed JSON body', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([
      {
        choices: [{ message: { content: '{not valid json' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage, onUsageFailure });

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u', jsonMode: true })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('parse');
    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 6 }),
      expect.objectContaining({ type: 'parse' }),
    );
  });

  it('reports usage failure with a normalized error when content is a non-string value', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([
      {
        // Malformed/non-conforming provider response: content isn't a
        // string, so `.trim()` throws a raw TypeError, not an LLMError.
        choices: [{ message: { content: { unexpected: 'object' } } }],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      } as never,
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsage, onUsageFailure });

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(err).toBeInstanceOf(LLMError); // normalized, not a raw TypeError
    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 10 }),
      expect.any(LLMError),
    );
  });

  it('does not fire onUsageFailure when no usage was reported on the failed response', async () => {
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([jsonResponse({ wrong: 'shape' })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      onUsageFailure,
    });

    await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: z.object({ name: z.string() }) })
      .catch(() => {});

    expect(onUsageFailure).not.toHaveBeenCalled();
  });

  it('does not fire onUsageFailure for transport failures, since no response ever arrived', async () => {
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([new Error('network down')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsageFailure });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});

    expect(onUsageFailure).not.toHaveBeenCalled();
  });

  it('never retries a validation/parse failure, so onUsageFailure fires exactly once even with retries configured', async () => {
    const onUsageFailure = vi.fn();
    const { client, calls } = createMockClient([
      jsonResponse({ wrong: 'shape' }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 3,
      onUsageFailure,
    });

    await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: z.object({ name: z.string() }) })
      .catch(() => {});

    expect(calls).toHaveLength(1);
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing onUsageFailure callback instead of masking the original error', async () => {
    const onUsageFailure = vi.fn(() => {
      throw new Error('onUsageFailure boom');
    });
    const { client } = createMockClient([
      jsonResponse({ wrong: 'shape' }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      onUsageFailure,
    });

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u', schema: z.object({ name: z.string() }) })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('validation'); // original error surfaces, not the hook's own throw
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
  });

  it('logs requestId, attempt, type, and tokens on a stacked, single-line format', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([
      jsonResponse({ wrong: 'shape' }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 2,
      logger,
    });

    await llm
      .call({
        systemPrompt: 's',
        userContent: 'u',
        requestId: 'req_test',
        schema: z.object({ name: z.string() }),
      })
      .catch(() => {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[VernLLM:req_test\] usage failure, attempt 1\/3: type=validation tokens=2$/,
      ),
    );
  });

  it('reports usage failure for a "validation" error thrown post-response too, e.g. unexpected tool_calls', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([]);
    client.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsage, onUsageFailure });

    // No `tools` passed, so the tool_calls response is unexpected -> LLMError('validation', code: 'unexpected_tool_calls').
    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('validation');
    expect(err.code).toBe('unexpected_tool_calls');
    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 4 }),
      expect.objectContaining({ type: 'validation', code: 'unexpected_tool_calls' }),
    );
  });

  it('reports usage failure on an empty response that still carried real usage', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockClient([]);
    client.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
    });
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsage, onUsageFailure });

    const err = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('api');
    expect(err.message).toMatch(/Empty LLM response/);
    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 7 }),
      expect.objectContaining({ type: 'api' }),
    );
  });

  it('falls back to promptTokens + completionTokens in the log line when totalTokens is 0', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([
      jsonResponse({ wrong: 'shape' }, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 0 }),
    ]);
    const llm = new VernLLM({ client, model: 'm', logger });

    await llm
      .call({
        systemPrompt: 's',
        userContent: 'u',
        requestId: 'req_z',
        schema: z.object({ name: z.string() }),
      })
      .catch(() => {});

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tokens=8'));
  });

  it('does not fire onUsageFailure when the signal is already aborted at failure time', async () => {
    const onUsageFailure = vi.fn();
    const controller = new AbortController();
    const { client } = createMockClient([]);
    client.chat.completions.create = vi.fn().mockImplementation(async () => {
      controller.abort();
      return jsonResponse(
        { wrong: 'shape' },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      );
    });
    const llm = new VernLLM({ client, model: 'm', onUsageFailure });

    const err = (await llm
      .call({
        systemPrompt: 's',
        userContent: 'u',
        signal: controller.signal,
        schema: z.object({ name: z.string() }),
      })
      .catch((e) => e)) as LLMError;

    expect(err.type).toBe('aborted');
    expect(onUsageFailure).not.toHaveBeenCalled();
  });
});
