import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ApplyGuardrailRequest,
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

/** Stands in for Bedrock answering an `ApplyGuardrailCommand`; the response may be partial. */
export type ApplyGuardrailHandler = (
  input: ApplyGuardrailRequest,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/**
 * A real `BedrockRuntimeClient` whose `send` is stubbed, so tests drive the
 * adapter through the SDK's own command classes without any network call.
 * Each command's input goes to the matching handler, with the abort signal
 * passed to `send`.
 */
export function stubbedClient(handlers: {
  converse?: ConverseHandler;
  converseStream?: ConverseStreamHandler;
  applyGuardrail?: ApplyGuardrailHandler;
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
    if (command instanceof ApplyGuardrailCommand && handlers.applyGuardrail) {
      return handlers.applyGuardrail(command.input, { signal });
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

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** A PNG whose header says `width` by `height`, with `extra` bytes after it. Enough to be read, not drawn. */
export function pngImage(width = 64, height = 64, extra = 0) {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return { data: base64(bytes), mimeType: 'image/png', bytes };
}

/** A JPEG whose first frame says `width` by `height`, behind one segment to skip. */
export function jpegImage(width = 64, height = 64) {
  const bytes = new Uint8Array(2 + 6 + 19);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]);
  bytes.set([0xff, 0xc0, 0, 17, 8], 8);
  new DataView(bytes.buffer).setUint16(13, height);
  new DataView(bytes.buffer).setUint16(15, width);
  return { data: base64(bytes), mimeType: 'image/jpeg', bytes };
}
