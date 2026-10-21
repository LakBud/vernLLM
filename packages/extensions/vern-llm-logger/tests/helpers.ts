import type { LLMClient, LLMError, WireStreamChunk } from 'vern-llm';

// Copied from the other extension and integration packages on purpose, so the packages stay
// independent of each other and of the core's own test files.

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string, usage?: CreateResult['usage']): CreateResult {
  return { choices: [{ message: { content: text } }], usage };
}

/** An error carrying an HTTP style status, as SDK errors typically do. */
export class FakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Step =
  | CreateResult
  | Error
  | ((params: CreateParams, signal: AbortSignal) => Promise<CreateResult>);

/** Each entry is a response or an error for that call. Calls past the end reuse the last entry. */
export function createMockClient(script: Step[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams, options: { signal: AbortSignal }) => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          /* v8 ignore next */
          if (entry === undefined) throw new Error('createMockClient: script is empty');
          if (entry instanceof Error) throw entry;
          if (typeof entry === 'function') return entry(params, options.signal);
          return entry;
        },
      },
    },
  };

  return { client, calls };
}

type StreamStep = WireStreamChunk[] | Error | (() => AsyncIterable<WireStreamChunk>);

export function createMockStreamingClient(script: StreamStep[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        /* v8 ignore next 3 */
        create: async () => {
          throw new Error('createMockStreamingClient: create() was not scripted');
        },
        createStream: (params: CreateParams): AsyncIterable<WireStreamChunk> => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          /* v8 ignore next */
          if (entry === undefined) throw new Error('createMockStreamingClient: script is empty');
          if (typeof entry === 'function') return entry();

          return {
            [Symbol.asyncIterator]() {
              let position = 0;
              return {
                async next(): Promise<IteratorResult<WireStreamChunk>> {
                  if (entry instanceof Error) throw entry;
                  const value = entry[position++];
                  return value === undefined
                    ? { done: true, value: undefined }
                    : { done: false, value };
                },
              };
            },
          };
        },
      },
    },
  };

  return { client, calls };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

export async function settleOutcome(promise: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

// Request ids are random per call, so they are masked before two runs are compared.
export const maskRequestIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'requestId' ? '<id>' : item)) as string);

/** What a caller can observe of an outcome, comparable between a run with and without a logger. */
export function describeOutcome(outcome: Outcome) {
  if (outcome.ok) return { ok: true, value: maskRequestIds(outcome.value) };
  const error = outcome.error as Partial<LLMError>;
  return {
    ok: false,
    name: (error as Error | undefined)?.name,
    type: error?.type,
    code: error?.code,
    status: error?.status,
    message: (error as Error | undefined)?.message,
  };
}
