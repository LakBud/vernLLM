import { createMockClient, textResponse } from '../../helpers.js';

import type {
  LLMClient,
  VernLLMMiddleware,
  VernLLMOptions,
  WireStreamChunk,
} from '../../../src/types/index.js';

type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

/** The plain text call most tests make. */
export const CALL = { userContent: 'hi', jsonMode: false as const };

export const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** A text response that also reports token usage, so a `usage` event fires. */
export function withUsage(text: string) {
  return { ...textResponse(text), usage: USAGE };
}

/** A `wrap` middleware that counts how many times it runs. */
export function wrapCounter(name = 'counter') {
  let count = 0;

  const middleware: VernLLMMiddleware = {
    name,
    wrap: async (_request, next) => {
      count++;
      return next();
    },
  };

  return { middleware, count: () => count };
}

/** A `wrap` middleware that records the `meta` its `next()` resolves with. */
export function metaRecorder(name = 'meta-recorder') {
  let meta: unknown;

  const middleware: VernLLMMiddleware = {
    name,
    wrap: async (_request, next) => {
      const result = await next();
      meta = result.meta;
      return result;
    },
  };

  return { middleware, meta: () => meta };
}

type Script = Parameters<typeof createMockClient>[0];

/**
 * A primary target playing `primaryScript` and one fallback playing `fallbackScript`, with retries
 * off so each target is tried once. Spread `options` into `new VernLLM`, then add what the test
 * needs. `primary` and `fallback` expose each mock client's `calls` and `create`.
 */
export function fallbackChain(primaryScript: Script, fallbackScript: Script) {
  const primary = createMockClient(primaryScript);
  const fallback = createMockClient(fallbackScript);

  const options: Pick<
    VernLLMOptions,
    'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback'
  > = {
    client: primary.client,
    model: 'primary-model',
    name: 'primary',
    maxRetries: 0,
    logger: 'silent',
    fallback: { client: fallback.client, model: 'fallback-model', name: 'fallback' },
  };

  return { primary, fallback, options };
}

/**
 * Three targets named `primary`, `b` and `c`, in that declared order, each playing its own script
 * with retries off. Spread `options` into `new VernLLM`. `primary`, `b` and `c` expose each mock
 * client's `calls` and `create`.
 */
export function targetChain(primaryScript: Script, bScript: Script, cScript: Script) {
  const primary = createMockClient(primaryScript);
  const b = createMockClient(bScript);
  const c = createMockClient(cScript);

  const options: Pick<
    VernLLMOptions,
    'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback'
  > = {
    client: primary.client,
    model: 'primary-model',
    name: 'primary',
    maxRetries: 0,
    logger: 'silent',
    fallback: [
      { client: b.client, model: 'b-model', name: 'b' },
      { client: c.client, model: 'c-model', name: 'c' },
    ],
  };

  return { primary, b, c, options };
}

/**
 * A mock response that waits until `release()` or until its attempt is aborted. `aborted()` says
 * whether the provider call was cancelled.
 */
export function heldResponse(text: string) {
  let release!: () => void;
  let wasAborted = false;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const entry = async (_params: CreateParams, signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      signal.addEventListener(
        'abort',
        () => {
          wasAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });

    return textResponse(text);
  };

  return { entry, release, aborted: () => wasAborted };
}

/** A rerunning `wrap` that starts the main chain and one more on `targets`, and keeps the first success. */
export function raceTwo(targets?: readonly string[], name = 'race-two'): VernLLMMiddleware {
  return {
    name,
    reruns: true,
    wrap: async (_request, next) => {
      if (!next.again) return next();

      return Promise.any([next(), next.again({ targets })]);
    },
  };
}

export interface StreamScript {
  text: string;
  /** Held until released, or until the stream's signal aborts. Opens the stream only after it. */
  gate?: Promise<void>;
  /** Held after the first chunk, so the stream stays open until it is cancelled. */
  hold?: boolean;
}

/** Rejects when `signal` aborts, so a held stream ends the way a real one does. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));

    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** A streaming client that plays one script per call and records each call's signal. */
export function streamClient(scripts: StreamScript[]) {
  const signals: AbortSignal[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: () => Promise.reject(new Error('not scripted')),
        createStream: (_params, options) => {
          const script = scripts[Math.min(index++, scripts.length - 1)]!;
          signals.push(options.signal);

          return {
            [Symbol.asyncIterator]() {
              let step = 0;

              return {
                async next(): Promise<IteratorResult<WireStreamChunk>> {
                  if (step === 0) {
                    if (script.gate) await Promise.race([script.gate, whenAborted(options.signal)]);
                    step++;

                    return { done: false, value: { type: 'text-delta', delta: script.text } };
                  }

                  if (script.hold) await whenAborted(options.signal);

                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      },
    },
  };

  return { client, signals };
}
