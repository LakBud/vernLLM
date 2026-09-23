import { describe, expect, it } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { FakeApiError, createMockClient, jsonResponse } from '../../helpers.js';

describe('VernLLM workflow, circuit breaker ignores caller side errors', () => {
  it('repeated 400s from one caller never open the circuit for healthy traffic', async () => {
    const { client, create } = createMockClient([
      new FakeApiError('bad request', 400),
      new FakeApiError('bad request', 400),
      new FakeApiError('bad request', 400),
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 3, cooldownMs: 30_000 },
    });

    for (let i = 0; i < 3; i++) {
      await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ status: 400 });
    }

    expect(llm.getCircuitState()).toBe('closed');
    await expect(llm.call({ userContent: 'u' })).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(4);
  });

  it.each([402, 413])(
    'a %i fails fast on the first attempt and leaves the circuit closed',
    async (status) => {
      const { client, create } = createMockClient([
        new FakeApiError('rejected', status),
        jsonResponse({ ok: true }),
      ]);

      const llm = new VernLLM({
        client,
        model: 'm',
        maxRetries: 3,
        baseDelayMs: 0,
        circuitBreaker: { threshold: 1, cooldownMs: 30_000 },
      });

      await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ status });
      expect(create).toHaveBeenCalledTimes(1);
      expect(llm.getCircuitState()).toBe('closed');
    },
  );

  it('a 5xx still opens the circuit', async () => {
    const { client } = createMockClient([new FakeApiError('down', 503)]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 30_000 },
    });

    await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ status: 503 });
    expect(llm.getCircuitState()).toBe('open');
  });
});
