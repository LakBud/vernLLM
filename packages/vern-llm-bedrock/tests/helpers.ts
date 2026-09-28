import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseRequest,
  type ConverseStreamRequest,
} from '@aws-sdk/client-bedrock-runtime';
import { vi } from 'vitest';

/** Stands in for Bedrock answering a `ConverseCommand`; the response may be partial. */
export type ConverseHandler = (
  input: ConverseRequest,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** Stands in for Bedrock answering a `ConverseStreamCommand` with `{ stream }`. */
export type ConverseStreamHandler = (
  input: ConverseStreamRequest,
  options: { signal: AbortSignal },
) => Promise<{ stream?: AsyncIterable<unknown> }>;

/**
 * A real `BedrockRuntimeClient` whose `send` is stubbed, so tests drive the
 * adapter through the SDK's own command classes without any network call.
 * Each command's input goes to the matching handler, with the abort signal
 * `fromBedrock` passed to `send`.
 */
export function stubbedClient(handlers: {
  converse?: ConverseHandler;
  converseStream?: ConverseStreamHandler;
}): BedrockRuntimeClient {
  const client = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  vi.spyOn(client, 'send').mockImplementation((async (
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => {
    const signal = options?.abortSignal as AbortSignal;

    if (command instanceof ConverseCommand && handlers.converse) {
      return handlers.converse(command.input, { signal });
    }
    if (command instanceof ConverseStreamCommand && handlers.converseStream) {
      return handlers.converseStream(command.input, { signal });
    }
    throw new Error(`stubbedClient has no handler for ${String(command)}`);
    // `send` is overloaded per command type; one stub serves both commands.
  }) as unknown as BedrockRuntimeClient['send']);

  return client;
}

/** An async iterable over `events`, running `onReturn` when the consumer stops early. */
export function fakeStream(
  events: unknown[],
  onReturn?: () => void | Promise<void>,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= events.length) return { done: true, value: undefined };
          const value = events[index];
          index++;
          return { done: false, value };
        },
        async return() {
          await onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Returns the element at `index`, failing the test when it is missing. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an element at index ${index}`);
  return item;
}
