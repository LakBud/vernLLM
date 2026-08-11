import { describe, expect, it } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse, toolCallResponse } from '../helpers.js';

describe('VernLLM workflow, circuit breaker isolateByModel', () => {
  it('a failing model does not block calls to a different, healthy model on the same instance', async () => {
    const { client } = createMockClient([
      new Error('down'), // gpt-4o fails and opens its own circuit
      jsonResponse({ ok: true }), // gpt-4o-mini succeeds right after
    ]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
    });

    await llm.call({ userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState('gpt-4o')).toBe('open');

    // A different model, via a per-call override, is unaffected and still reaches the client.
    await expect(llm.call({ userContent: 'u', model: 'gpt-4o-mini' })).resolves.toEqual({
      ok: true,
    });
    expect(llm.getCircuitState('gpt-4o-mini')).toBe('closed');

    // The failing model is still blocked without hitting the client again.
    await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ type: 'circuit_open' });
  });
});

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

describe('VernLLM workflow, tool contract failures and the circuit breaker', () => {
  it('repeated unknown-tool responses do not open the breaker or block unrelated calls', async () => {
    const { client } = createMockClient([
      toolCallResponse([{ id: 'call_1', name: 'not_a_real_tool', arguments: {} }]),
      toolCallResponse([{ id: 'call_2', name: 'not_a_real_tool', arguments: {} }]),
      toolCallResponse([{ id: 'call_3', name: 'not_a_real_tool', arguments: {} }]),
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      // A low threshold makes the point sharply: even well past it, a
      // string of tool-contract failures alone must never open this.
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    for (let i = 0; i < 3; i++) {
      await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
        code: 'unknown_tool',
      });
    }

    expect(llm.getCircuitState()).toBe('closed');

    // An unrelated, healthy call still reaches the client normally.
    await expect(llm.call({ userContent: 'hi' })).resolves.toEqual({ ok: true });
  });

  it('repeated duplicate-call-id responses do not open the breaker either', async () => {
    const duplicateResponse = toolCallResponse([
      { id: 'call_1', name: 'get_weather', arguments: { city: 'NYC' } },
      { id: 'call_1', name: 'get_weather', arguments: { city: 'LA' } },
    ]);

    const { client } = createMockClient([
      duplicateResponse,
      duplicateResponse,
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    for (let i = 0; i < 2; i++) {
      await expect(llm.call({ userContent: 'hi', tools: [weatherTool] })).rejects.toMatchObject({
        code: 'duplicate_tool_call_id',
      });
    }

    expect(llm.getCircuitState()).toBe('closed');
    await expect(llm.call({ userContent: 'hi' })).resolves.toEqual({ ok: true });
  });
});
