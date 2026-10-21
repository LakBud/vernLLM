import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import {
  createMockClient,
  describeOutcome,
  FakeApiError,
  settleOutcome,
  sleep,
  textResponse,
} from '../helpers.js';

// One data table and one runner. Every row runs twice, with and without the logger, and the
// caller must not be able to tell the difference. Only then is the record checked.

const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const ok = (text = 'ok') => textResponse(text, USAGE);
const serverError = () => new FakeApiError('provider said: secret prompt text', 500);

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const call = { userContent: 'hi', jsonMode: false as const };

const primaryAndFallback = (
  primary: Parameters<typeof createMockClient>[0],
  fallback: Parameters<typeof createMockClient>[0],
) => ({
  client: createMockClient(primary).client,
  fallback: { client: createMockClient(fallback).client, model: 'claude-x' },
});

interface Scenario {
  name: string;
  /** Builds a fresh instance. `logger` is empty for the baseline run. */
  build(logger: VernLLMMiddleware[]): { execute(): Promise<unknown> };
  /** One matcher per record expected, in the order the records were written. */
  records: Array<Record<string, unknown>>;
  check?: (records: CallLogRecord[]) => void;
}

const scenarios: Scenario[] = [
  {
    name: 'success',
    build: (logger) => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([ok()]).client,
        middleware: logger,
      });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        kind: 'call',
        v: 1,
        outcome: 'ok',
        level: 'info',
        provider: 'primary',
        model: 'gpt-4o',
        fallbackIndex: -1,
        attempts: 1,
        retries: 0,
        streaming: false,
        path: [{ provider: 'primary', model: 'gpt-4o', attempts: 1, outcome: 'ok' }],
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      },
    ],
    check: ([record]) => {
      expect(record!.outputTokensPerSec).toBeGreaterThan(0);
      for (const absent of ['error', 'breaker', 'middleware', 'custom', 'cache', 'reason']) {
        expect(record).not.toHaveProperty(absent);
      }
    },
  },
  {
    name: 'retry then success',
    build: (logger) => {
      const client = createMockClient([serverError(), ok()]).client;
      const llm = new VernLLM({ ...BASE, maxRetries: 2, client, middleware: logger });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'ok',
        attempts: 2,
        retries: 1,
        path: [{ provider: 'primary', attempts: 2, outcome: 'ok' }],
      },
    ],
    check: ([record]) => expect(record!.retryDelayMs).toBeGreaterThanOrEqual(0),
  },
  {
    name: 'soft failure then a retry',
    build: (logger) => {
      const client = createMockClient([ok('N/A'), ok('real answer')]).client;
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client,
        middleware: logger,
        detectSoftFailure: (result) =>
          typeof result === 'string' && result.trim() === 'N/A' ? 'empty_response' : undefined,
      });
      return { execute: () => llm.call(call) };
    },
    // `dispatch` resolved for the first attempt, but the answer was rejected afterwards, so the
    // retry event is what closes it. Both attempts are real.
    records: [{ outcome: 'ok', attempts: 2, retries: 1, path: [{ attempts: 2, outcome: 'ok' }] }],
    check: ([record]) => expect(record).not.toHaveProperty('usageFailed'),
  },
  {
    name: 'soft failure with no retries left',
    build: (logger) => {
      const client = createMockClient([ok('N/A')]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: logger,
        detectSoftFailure: () => 'empty_response',
      });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'error',
        level: 'error',
        attempts: 1,
        usageFailed: true,
        usage: { promptTokens: 3, completionTokens: 4 },
        path: [{ attempts: 1, outcome: 'error' }],
      },
    ],
  },
  {
    name: 'retries exhausted, then a fallback answers',
    build: (logger) => {
      const { client, fallback } = primaryAndFallback([serverError()], [ok()]);
      const llm = new VernLLM({ ...BASE, maxRetries: 1, client, fallback, middleware: logger });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'ok',
        provider: 'fallback[0]',
        model: 'claude-x',
        fallbackIndex: 0,
        attempts: 3,
        retries: 1,
        path: [
          { provider: 'primary', model: 'gpt-4o', attempts: 2, outcome: 'error' },
          { provider: 'fallback[0]', model: 'claude-x', attempts: 1, outcome: 'ok' },
        ],
      },
    ],
    check: ([record]) => {
      expect(record!.path[0]!.errorCode).toBeTruthy();
      expect(record!.path[1]).not.toHaveProperty('errorCode');
      // The core's figure for the target left behind, which spans its retries.
      expect(record!.path[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  },
  {
    name: 'every target fails',
    build: (logger) => {
      const { client, fallback } = primaryAndFallback([serverError()], [serverError()]);
      const llm = new VernLLM({ ...BASE, client, fallback, middleware: logger });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'error',
        level: 'error',
        attempts: 2,
        error: { type: 'fallback_exhausted' },
        path: [
          { provider: 'primary', attempts: 1, outcome: 'error' },
          { provider: 'fallback[0]', attempts: 1, outcome: 'error' },
        ],
      },
    ],
    check: ([record]) => {
      // Who answered is unknown, since nobody did.
      for (const absent of ['provider', 'model', 'fallbackIndex']) {
        expect(record).not.toHaveProperty(absent);
      }
      // The last target's own reason, not the summary error's.
      expect(record!.path[1]!.errorCode).not.toBe('fallback_exhausted');
    },
  },
  {
    name: 'terminal failure with no retry and no fallback',
    build: (logger) => {
      const client = createMockClient([new FakeApiError('bad request', 400)]).client;
      const llm = new VernLLM({ ...BASE, maxRetries: 2, client, middleware: logger });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'error',
        level: 'error',
        attempts: 1,
        retries: 0,
        error: { status: 400 },
        path: [{ attempts: 1, outcome: 'error' }],
      },
    ],
  },
  {
    name: 'rate limit wait',
    build: (logger) => {
      const slow = async () => {
        await sleep(80);
        return ok();
      };
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([slow]).client,
        rateLimit: { maxConcurrent: 1 },
        middleware: logger,
      });
      return { execute: () => Promise.all([llm.call(call), llm.call(call)]) };
    },
    records: [{ outcome: 'ok', queueWaitMs: 0 }, { outcome: 'ok' }],
    check: ([, second]) => expect(second!.queueWaitMs).toBeGreaterThan(50),
  },
  {
    name: 'primary circuit opens, then a fallback serves the next call',
    build: (logger) => {
      const { client, fallback } = primaryAndFallback([serverError()], [ok()]);
      const llm = new VernLLM({
        ...BASE,
        client,
        fallback,
        circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
        middleware: logger,
      });
      return { execute: async () => [await llm.call(call), await llm.call(call)] };
    },
    records: [
      {
        outcome: 'ok',
        provider: 'fallback[0]',
        breaker: [{ provider: 'primary', model: 'gpt-4o', from: 'closed', to: 'open' }],
        path: [
          { provider: 'primary', outcome: 'error' },
          { provider: 'fallback[0]', outcome: 'ok' },
        ],
      },
      {
        outcome: 'ok',
        provider: 'fallback[0]',
        path: [{ provider: 'fallback[0]', outcome: 'ok' }],
      },
    ],
  },
  {
    name: 'inner wrap short circuit',
    build: (logger) => {
      const { client } = createMockClient([ok()]);
      const guard: VernLLMMiddleware = { name: 'guard', wrap: async () => ({ value: 'short' }) };
      const llm = new VernLLM({ ...BASE, client, middleware: [guard, ...logger] });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'ok',
        attempts: 0,
        path: [],
        shortCircuitedBy: 'guard',
        middleware: [{ kind: 'wrap_short_circuit', name: 'guard' }],
      },
    ],
    check: ([record]) => expect(record).not.toHaveProperty('provider'),
  },
  {
    name: 'abort in the middle of a call',
    build: (logger) => {
      const hangs = (_params: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('client saw the abort')));
        });
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([hangs]).client,
        middleware: logger,
      });
      return {
        execute: () => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 15);
          return llm.call({ ...call, signal: controller.signal });
        },
      };
    },
    // The caller cancelled, so this is not a fault: `info`, not `error`.
    records: [
      {
        outcome: 'aborted',
        level: 'info',
        attempts: 1,
        error: { type: 'aborted' },
        path: [{ attempts: 1, outcome: 'error', errorCode: 'aborted' }],
      },
    ],
    check: ([record]) => expect(record!.durationMs).toBeGreaterThanOrEqual(10),
  },
  {
    name: 'a transform patches the request',
    build: (logger) => {
      const patcher: VernLLMMiddleware = { name: 'patcher', transform: () => ({ temperature: 0 }) };
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([ok()]).client,
        middleware: [patcher, ...logger],
      });
      return { execute: () => llm.call(call) };
    },
    records: [
      {
        outcome: 'ok',
        middleware: [{ kind: 'transform', name: 'patcher', patchedFields: ['temperature'] }],
      },
    ],
  },
];

describe('loggerMiddleware scenarios', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const baseline = await settleOutcome(scenario.build([]).execute());

    const sink = memorySink();
    const logged = await settleOutcome(
      scenario.build([loggerMiddleware({ sink, logger: 'silent' })]).execute(),
    );

    // The caller sees exactly what it would without the logger.
    expect(describeOutcome(logged)).toEqual(describeOutcome(baseline));

    const records = sink.entries.map(({ entry }) => entry as CallLogRecord);
    expect(records).toHaveLength(scenario.records.length);
    records.forEach((record, index) => expect(record).toMatchObject(scenario.records[index]!));

    for (const record of records) {
      expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
      expect(record.requestId).toBeTruthy();
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.queueWaitMs).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(record)).toBe(true);
      // Never the message: it can echo prompt text.
      expect(JSON.stringify(record)).not.toContain('secret prompt text');
    }
    // The level on the record is the level it was written at.
    sink.entries.forEach(({ level, entry }) => expect(level).toBe((entry as CallLogRecord).level));

    scenario.check?.(records);
  });
});
