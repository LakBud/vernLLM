import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loggerMiddleware, memorySink, type LoggerMiddlewareOptions } from '../../src/index.js';
import { CallRecorder } from '../../src/internal/recorder/callRecorder.js';
import {
  createMockClient,
  createMockStreamingClient,
  describeOutcome,
  FakeApiError,
  maskRequestIds,
  settleOutcome,
  textResponse,
} from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

afterEach(() => {
  vi.useRealTimers();
});

// Each case runs with a logger whose own code misbehaves and with no logger at all. What the
// caller observes must be identical.
async function observed(
  script: Parameters<typeof createMockClient>[0],
  options?: LoggerMiddlewareOptions,
) {
  const llm = new VernLLM({
    client: createMockClient(script).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: options ? [loggerMiddleware({ logger: 'silent', ...options })] : [],
  });
  return describeOutcome(await settleOutcome(llm.call(call)));
}

const broken: Record<string, LoggerMiddlewareOptions> = {
  'a throwing sink': {
    sink: {
      write: () => {
        throw new Error('sink down');
      },
    },
  },
  'a rejecting sink': { sink: { write: () => Promise.reject(new Error('sink down')) } },
  'a throwing enricher': {
    enrich: () => {
      throw new Error('enrich down');
    },
  },
  'a throwing dimension': {
    dimensions: {
      tenant: () => {
        throw new Error('dimension down');
      },
    },
  },
  'a throwing onSummary': {
    summary: {
      everyMs: 1000,
      onSummary: () => {
        throw new Error('summary down');
      },
    },
  },
};

describe('a misbehaving logger never changes the call', () => {
  for (const [name, options] of Object.entries(broken)) {
    it(`${name}: success`, async () => {
      expect(maskRequestIds(await observed([textResponse('ok')], options))).toEqual(
        maskRequestIds(await observed([textResponse('ok')])),
      );
    });

    it(`${name}: failure`, async () => {
      expect(await observed([new FakeApiError('down', 500)], options)).toEqual(
        await observed([new FakeApiError('down', 500)]),
      );
    });
  }

  it('survives a throwing onSummary on the scheduler tick', async () => {
    vi.useFakeTimers();
    const llm = new VernLLM({
      client: createMockClient([textResponse('ok')]).client,
      model: 'gpt-4o',
      logger: 'silent',
      middleware: [
        loggerMiddleware({
          logger: 'silent',
          sink: { write: () => {} },
          window: { durationMs: 2000, slots: 2 },
          summary: {
            everyMs: 1000,
            onSummary: () => {
              throw new Error('summary down');
            },
          },
        }),
      ],
    });
    await llm.call(call);

    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow();
  });

  it('still returns the result and the error when building the record throws', async () => {
    const spy = vi.spyOn(CallRecorder.prototype, 'finish').mockImplementation(() => {
      throw new Error('record down');
    });
    try {
      await expect(observed([textResponse('ok')])).resolves.toBeDefined();
      expect(await observed([textResponse('ok')], {})).toEqual(
        await observed([textResponse('ok')]),
      );
      expect(await observed([new FakeApiError('down', 500)], {})).toEqual(
        await observed([new FakeApiError('down', 500)]),
      );

      const llm = new VernLLM({
        client: createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]).client,
        model: 'gpt-4o',
        maxRetries: 0,
        logger: 'silent',
        middleware: [loggerMiddleware({ sink: memorySink(), logger: 'silent' })],
      });
      const stream = await llm.call({ ...call, stream: true as const });
      await expect(stream.finalResult).resolves.toBe('x');
    } finally {
      spy.mockRestore();
    }
  });

  it('records a stream that cannot be observed as it stands', async () => {
    const sink = memorySink();
    const breakFinalResult: VernLLMMiddleware = {
      name: 'break-final-result',
      wrap: async (_request, next) => {
        const result = await next();
        const value = result.value as object;
        return {
          ...result,
          value: {
            ...value,
            finalResult: {
              then() {
                throw new Error('thenable down');
              },
            },
          },
        };
      },
    };
    const llm = new VernLLM({
      client: createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]).client,
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      middleware: [loggerMiddleware({ sink, logger: 'silent' }), breakFinalResult],
    });

    await llm.call({ ...call, stream: true as const });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]!.entry).toMatchObject({ kind: 'call', outcome: 'ok', streaming: true });
  });
});
