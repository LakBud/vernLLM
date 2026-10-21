import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  loggerMiddleware,
  memorySink,
  type BreakerEntry,
  type CallLogRecord,
} from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

function setup(level?: 'debug' | 'info' | 'warn' | 'error') {
  const sink = memorySink();
  const llm = new VernLLM({
    client: createMockClient([new Error('down'), textResponse('ok')]).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    middleware: [loggerMiddleware({ sink, logger: 'silent', ...(level ? { level } : {}) })],
  });
  return { llm, sink };
}

describe('circuit breaker changes', () => {
  it('writes a breaker entry for a change outside any call, at warn when it opens', () => {
    const { llm, sink } = setup();

    llm.openCircuit();
    llm.closeCircuit();

    expect(sink.entries).toEqual([
      {
        level: 'warn',
        entry: expect.objectContaining({ kind: 'breaker', v: 1, provider: 'primary', to: 'open' }),
      },
      {
        level: 'info',
        entry: expect.objectContaining({ kind: 'breaker', from: 'open', to: 'closed' }),
      },
    ]);
    expect((sink.entries[0]!.entry as BreakerEntry).consecutiveFailures).toEqual(
      expect.any(Number),
    );
  });

  it('keeps a change caused by a call on that call, with no separate entry', async () => {
    const { llm, sink } = setup();

    await llm.call({ userContent: 'hi', jsonMode: false }).catch(() => {});

    const kinds = sink.entries.map(({ entry }) => entry.kind);
    expect(kinds).toEqual(['call']);
    expect((sink.entries[0]!.entry as CallLogRecord).breaker).toEqual([
      expect.objectContaining({ from: 'closed', to: 'open' }),
    ]);
  });

  it('applies the level filter to breaker entries', () => {
    const { llm, sink } = setup('warn');

    llm.openCircuit();
    llm.closeCircuit();

    expect(sink.entries.map(({ level }) => level)).toEqual(['warn']);
  });
});
