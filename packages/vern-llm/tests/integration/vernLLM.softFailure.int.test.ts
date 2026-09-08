import { describe, expect, it } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, drain, textResponse } from '../helpers.js';

// A non-empty placeholder the model sometimes returns instead of a real
// answer. Deliberately non-empty so it clears the existing empty-response
// guard in shapeResponse and only detectSoftFailure itself flags it.
const PLACEHOLDER = 'N/A';

function flagPlaceholder(result: unknown) {
  return typeof result === 'string' && result.trim() === PLACEHOLDER ? 'empty_response' : undefined;
}

describe('detectSoftFailure end to end', () => {
  it('fails an otherwise-clean response and lets it retry into a later success', async () => {
    const { client, create } = createMockClient([
      textResponse(PLACEHOLDER),
      textResponse('real answer'),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      detectSoftFailure: flagPlaceholder,
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('real answer');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit once repeated soft failures cross the threshold, same as a real failure would', async () => {
    const { client } = createMockClient([textResponse(PLACEHOLDER), textResponse(PLACEHOLDER)]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
      detectSoftFailure: flagPlaceholder,
    });

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).rejects.toMatchObject({
      type: 'api',
      code: 'empty_response',
    });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).rejects.toMatchObject({
      type: 'api',
      code: 'empty_response',
    });
    expect(llm.getCircuitStates()[0]?.state).toBe('open');
  });

  it('leaves a normal response untouched when no hook is configured', async () => {
    const { client } = createMockClient([textResponse('all good')]);

    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('all good');
  });

  it('a hook that throws does not fail the call, and the response still succeeds', async () => {
    const { client } = createMockClient([textResponse('fine')]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: () => {
        throw new Error('hook is broken');
      },
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('fine');
  });

  it('a streaming call with a clean response is untouched by the hook', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'real text' }]]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: flagPlaceholder,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hello',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);

    await expect(finalResult).resolves.toBe('real text');
  });

  it('a streaming soft failure rejects finalResult with the hook-supplied code', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: PLACEHOLDER }]]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: flagPlaceholder,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hello',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);

    await expect(finalResult).rejects.toMatchObject({ type: 'api', code: 'empty_response' });
  });

  it('opens the circuit on repeated streaming soft failures, same as a non-streaming call would', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: PLACEHOLDER }],
      [{ type: 'text-delta', delta: PLACEHOLDER }],
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
      detectSoftFailure: flagPlaceholder,
    });

    const first = await llm.call({ userContent: 'hello', jsonMode: false, stream: true });
    await drain(first.chunks);
    await expect(first.finalResult).rejects.toMatchObject({ code: 'empty_response' });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');

    const second = await llm.call({ userContent: 'hello', jsonMode: false, stream: true });
    await drain(second.chunks);
    await expect(second.finalResult).rejects.toMatchObject({ code: 'empty_response' });
    expect(llm.getCircuitStates()[0]?.state).toBe('open');
  });

  it('passes the real extracted usage through to the hook on a non-streaming call', async () => {
    let seenUsage: unknown;
    const { client } = createMockClient([
      {
        choices: [{ message: { content: 'real answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      },
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: (result, meta) => {
        seenUsage = meta.usage;
        return undefined;
      },
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(seenUsage).toMatchObject({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
  });

  it('passes usage through as undefined when the provider omits it, on a non-streaming call', async () => {
    let sawHook = false;
    let seenUsage: unknown = 'not set';
    const { client } = createMockClient([textResponse('real answer')]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: (_result, meta) => {
        sawHook = true;
        seenUsage = meta.usage;
        return undefined;
      },
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(sawHook).toBe(true);
    expect(seenUsage).toBeUndefined();
  });

  it('passes the real extracted usage through to the hook on a streaming call', async () => {
    let seenUsage: unknown;
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'real text' },
        { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
      ],
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      detectSoftFailure: (_result, meta) => {
        seenUsage = meta.usage;
        return undefined;
      },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hello',
      jsonMode: false,
      stream: true,
    });
    await drain(chunks);
    await finalResult;

    expect(seenUsage).toMatchObject({ promptTokens: 8, completionTokens: 3, totalTokens: 11 });
  });
});
