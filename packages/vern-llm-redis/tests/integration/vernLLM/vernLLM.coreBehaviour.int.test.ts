import {
  LLMError,
  VernLLM,
  type LLMClient,
  type VernLLMMiddleware,
  type WireStreamChunk,
} from 'vern-llm';
import { describe, expect, vi } from 'vitest';

import { it } from '../../fixtures.js';
import { uniquePrefix, waitUntil } from '../../helpers.js';

/** One scripted stream: its chunks, then a failure or a hang until aborted. */
interface StreamStep {
  chunks: WireStreamChunk[];
  failWith?: Error;
  hang?: boolean;
}

/** A client whose streams follow `steps`, one per call, repeating the last. */
function streamingClient(steps: StreamStep[]): LLMClient {
  let call = 0;

  const createStream = (_params: unknown, options: { signal: AbortSignal }) => {
    const step = steps[Math.min(call, steps.length - 1)]!;
    call += 1;

    return (async function* () {
      for (const chunk of step.chunks) yield chunk;
      if (step.failWith) throw step.failWith;
      if (step.hang) {
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      }
    })();
  };

  return {
    chat: { completions: { create: vi.fn(), createStream } },
  } as unknown as LLMClient;
}

/** A client whose non streaming calls all answer with `reply`. */
function replyingClient(reply: object): LLMClient {
  return { chat: { completions: { create: vi.fn(async () => reply) } } } as unknown as LLMClient;
}

const aimd = { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 };

describe.concurrent('redis adapters under VernLLM, real Redis', () => {
  it('the provider request goes out only after Redis granted capacity', async ({
    makeLimiter,
    makeBreaker,
  }) => {
    const limiter = makeLimiter({ maxConcurrent: 1, keyPrefix: uniquePrefix('rl') });
    const inFlightAtDispatch: number[] = [];
    const probe: VernLLMMiddleware = {
      name: 'probe',
      dispatch: async (_request, next) => {
        inFlightAtDispatch.push((await limiter.readState()).concurrentInFlight!);
        await next();
      },
    };
    const llm = new VernLLM({
      client: replyingClient({ choices: [{ message: { content: 'ok' } }] }),
      model: 'm',
      logger: 'silent',
      rateLimit: limiter,
      circuitBreaker: makeBreaker({ keyPrefix: uniquePrefix('cb') }),
      middleware: [probe],
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    expect(inFlightAtDispatch).toEqual([1]);
  });

  it('an open Redis circuit stops the call before it takes capacity or dispatches', async ({
    makeLimiter,
    makeBreaker,
  }) => {
    const limiter = makeLimiter({ requestsPerMinute: 10, keyPrefix: uniquePrefix('rl') });
    const breaker = makeBreaker({ keyPrefix: uniquePrefix('cb'), cooldownMs: 30_000 });
    breaker.open?.('m');
    await waitUntil(() => breaker.getState?.('m') === 'open');
    const dispatch = vi.fn(async (_request: unknown, next: () => Promise<void>) => next());
    const llm = new VernLLM({
      client: replyingClient({ choices: [{ message: { content: 'ok' } }] }),
      model: 'm',
      logger: 'silent',
      rateLimit: limiter,
      circuitBreaker: breaker,
      middleware: [{ name: 'probe', dispatch }],
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      type: 'circuit_open',
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect((await limiter.readState()).requestsRemaining).toBe(10);
  });

  it('a 429 after the first chunk still shrinks the Redis AIMD ceiling, with retryAfterMs capped', async ({
    redis,
    makeLimiter,
  }) => {
    const keyPrefix = uniquePrefix('rl');
    const llm = new VernLLM({
      client: streamingClient([
        {
          chunks: [{ type: 'text-delta', delta: 'partial' }],
          // A provider's 429 carries its HTTP status, which is what AIMD reacts to.
          failWith: new LLMError('slow down', 'rate_limited', {
            status: 429,
            retryAfterMs: 60_000,
          }),
        },
      ]),
      model: 'm',
      logger: 'silent',
      maxRetryAfterMs: 2000,
      rateLimit: makeLimiter({ requestsPerMinute: 10, aimd, keyPrefix }),
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    const settled = finalResult.catch((error: unknown) => error);
    // The failure reaches the reader too, after the chunk already sent.
    await expect(
      (async () => {
        for await (const _chunk of chunks) {
          // Drain until the stream fails.
        }
      })(),
    ).rejects.toMatchObject({ type: 'rate_limited' });

    expect(await settled).toMatchObject({ type: 'rate_limited', retryAfterMs: 2000 });
    await waitUntil(async () => Number(await redis.hget(`{${keyPrefix}:rpm}:aimd`, 'cap')) === 5);
  });

  it('breaking out of a stream frees the Redis concurrency slot and never counts toward the Redis breaker', async ({
    makeLimiter,
    makeBreaker,
  }) => {
    const limiter = makeLimiter({ maxConcurrent: 1, keyPrefix: uniquePrefix('rl') });
    const breaker = makeBreaker({ keyPrefix: uniquePrefix('cb'), threshold: 1 });
    const llm = new VernLLM({
      client: streamingClient([
        {
          chunks: [
            { type: 'text-delta', delta: 'a' },
            { type: 'text-delta', delta: 'b' },
          ],
          hang: true,
        },
      ]),
      model: 'm',
      logger: 'silent',
      rateLimit: limiter,
      circuitBreaker: breaker,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    const settled = finalResult.catch((error: unknown) => error);
    expect((await limiter.readState()).concurrentInFlight).toBe(1);

    for await (const _chunk of chunks) break;

    expect(await settled).toMatchObject({ type: 'aborted' });
    await waitUntil(async () => (await limiter.readState()).concurrentInFlight === 0);
    // Give any breaker write time to land, then read Redis itself.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await breaker.readState?.('m')).toBe('closed');
    expect(breaker.getFailureBreakdown?.('m') ?? {}).toEqual({});
  });

  it('a truncated JSON reply never counts toward the Redis breaker', async ({ makeBreaker }) => {
    const breaker = makeBreaker({ keyPrefix: uniquePrefix('cb'), threshold: 1 });
    const llm = new VernLLM({
      client: replyingClient({
        choices: [{ message: { content: '{"answer": "cut of' }, finish_reason: 'length' }],
      }),
      model: 'm',
      logger: 'silent',
      maxRetries: 0,
      circuitBreaker: breaker,
    });

    await expect(llm.call({ userContent: 'hi' })).rejects.toMatchObject({
      code: 'response_truncated',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await breaker.readState?.('m')).toBe('closed');
  });

  it('reported usage above the estimate is charged to the Redis tokens bucket', async ({
    makeLimiter,
  }) => {
    const limiter = makeLimiter({
      tokensPerMinute: 10_000,
      keyPrefix: uniquePrefix('rl'),
      // Pins the estimate, so the only thing moving the bucket is usage.
      estimateTokens: () => 100,
    });
    const llm = new VernLLM({
      client: replyingClient({
        choices: [{ message: { content: 'ok' } }],
        // Prompt tokens including a prompt cache write, the way fromAnthropic reports them now.
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
      }),
      model: 'm',
      logger: 'silent',
      rateLimit: limiter,
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    // The bucket refills about 167 tokens a second, so a slow run reads well above an exact
    // 9000. Below the midpoint between the charged 9000 and the 9900 the estimate alone leaves.
    await waitUntil(async () => (await limiter.readState()).tokensRemaining! < 9450);
    expect((await limiter.readState()).tokensRemaining).toBeGreaterThan(8990);
  });

  it('all zero usage refunds nothing, the estimate stays spent', async ({ makeLimiter }) => {
    // A slow refill (10 tokens a second), so a slow run barely moves the bucket.
    const limiter = makeLimiter({
      tokensPerMinute: 600,
      keyPrefix: uniquePrefix('rl'),
      estimateTokens: () => 100,
    });
    const llm = new VernLLM({
      client: replyingClient({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      model: 'm',
      logger: 'silent',
      rateLimit: limiter,
    });

    await llm.call({ userContent: 'hi', jsonMode: false });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Spent 100 of 600. A refund would refill the bucket to its 600 cap, which
    // plain refill only reaches after ten seconds.
    const remaining = (await limiter.readState()).tokensRemaining!;
    expect(remaining).toBeLessThan(590);
    expect(remaining).toBeGreaterThan(495);
  });

  it("an image's base64 data is not estimated as text tokens", async ({ makeLimiter }) => {
    const limiter = makeLimiter({ tokensPerMinute: 10_000_000, keyPrefix: uniquePrefix('rl') });
    const base64 = 'A'.repeat(400_000);

    const estimate = limiter.estimate({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: base64 } },
          ],
        },
      ],
    } as never);

    // Counted as text, 400k characters would be about 100k tokens.
    expect(estimate).toBeLessThan(10_000);
  });
});
