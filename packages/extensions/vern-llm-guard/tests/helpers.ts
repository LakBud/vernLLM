import {
  VernLLM,
  createMiddlewareStateBag,
  type CallParams,
  type LLMClient,
  type Logger,
  type PreDispatchContext,
  type VernLLMMiddleware,
  type VernLLMOptions,
  type WireCallRequest,
  type WireStreamChunk,
} from 'vern-llm';

import { MODERATION_CATEGORIES } from '../src/detectors/openaiModeration.js';
import {
  guardLabels,
  guardMiddleware,
  type ClassifierAnswer,
  type ClassifierLLM,
  type GuardOptions,
  type ModerationCategory,
  type ModerationClient,
  type ModerationImagePart,
  type ModerationResult,
} from '../src/index.js';

import type { GuardrailClient } from 'vern-llm-bedrock/guardrail';

// Copied from the other extension packages on purpose, so the packages stay independent of each
// other and of the core's own test files.

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
export type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string): CreateResult {
  return { choices: [{ message: { content: text } }] };
}

/** What a target answers with, from the request it was given. An `Error` is thrown. */
export type Responder = (params: CreateParams) => CreateResult | string | Error;

/** A client that answers each call from its request, so a test can echo what it was sent. */
export function createResponderClient(respond: Responder) {
  const calls: CreateParams[] = [];

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams) => {
          calls.push(params);
          const answer = respond(params);
          if (answer instanceof Error) throw answer;
          return typeof answer === 'string' ? textResponse(answer) : answer;
        },
      },
    },
  };

  return { client, calls };
}

/** What a streaming target yields, from the request it was given. */
export type StreamSource =
  | WireStreamChunk[]
  | ((params: CreateParams, signal: AbortSignal) => AsyncIterable<WireStreamChunk>);

/**
 * A client whose `createStream` yields the scripted chunks, one turn of the event loop apart.
 * `finished` says whether the provider was let run to its end, so a test can see a cancel.
 */
export function createStreamClient(source: StreamSource) {
  const calls: CreateParams[] = [];
  const state = { finished: false, started: false };

  const client: LLMClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('createStreamClient: only streams are scripted');
        },
        createStream: (params: CreateParams, options: { signal: AbortSignal }) => {
          calls.push(params);
          state.started = true;
          const inner =
            typeof source === 'function'
              ? source(params, options.signal)
              : (async function* () {
                  for (const chunk of source) yield chunk;
                })();
          return (async function* () {
            for await (const chunk of inner) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              yield chunk;
            }
            state.finished = true;
          })();
        },
      },
    },
  };

  return { client, calls, state };
}

/** The first token of a request, the way a provider that was shown it would repeat it. */
export function tokenIn(params: CreateParams): string {
  return /x[0-9a-f]{6}@redacted\.invalid|\[[A-Z0-9_]+_[0-9a-f]{4}\]/i.exec(
    JSON.stringify(params.messages),
  )![0];
}

/** Splits text into pieces of the given sizes, then the rest, as text deltas. */
export function textDeltas(text: string, ...sizes: number[]): WireStreamChunk[] {
  const chunks: WireStreamChunk[] = [];
  let at = 0;
  for (const size of sizes) {
    chunks.push({ type: 'text-delta', delta: text.slice(at, at + size) });
    at += size;
  }
  if (at < text.length) chunks.push({ type: 'text-delta', delta: text.slice(at) });
  return chunks;
}

/** The text of the last user message of a request, as the provider received it. */
export function lastUserText(params: CreateParams): string {
  const message = [...params.messages].reverse().find((entry) => entry.role === 'user');
  if (message?.role !== 'user') return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** An error the core reads as a provider outage, so a fallback is tried. */
export function serverError(): Error {
  return Object.assign(new Error('server error'), { status: 500 });
}

/**
 * A real `VernLLM` over two mock targets, `primary` and `b`, with the guard outermost. A probe just
 * inside it records the labels it can read, and `events` collects every custom event.
 */
export function harness(
  guard: Pick<GuardOptions, 'checks'> & Partial<GuardOptions>,
  vern: Partial<VernLLMOptions> = {},
  answers: { primary?: Responder; b?: Responder } = {},
) {
  const primary = createResponderClient(answers.primary ?? (() => 'primary'));
  const b = createResponderClient(answers.b ?? (() => 'b'));
  const labels: (readonly string[] | undefined)[] = [];
  const events: { name: string; data: unknown }[] = [];

  const middleware = guardMiddleware({ version: 'v1', logger: 'silent', ...guard });
  const probe: VernLLMMiddleware = {
    name: 'probe',
    position: 0,
    wrap: (_request, next, ctx) => {
      labels.push(guardLabels(ctx));
      return next();
    },
  };
  const recorder: VernLLMMiddleware = {
    name: 'events',
    onEvent: (event) => {
      if (event.kind === 'custom') events.push({ name: event.name, data: event.data });
    },
  };

  const llm = new VernLLM({
    client: primary.client,
    model: 'primary-model',
    name: 'primary',
    maxRetries: 0,
    logger: 'silent',
    fallback: [{ client: b.client, model: 'b-model', name: 'b' }],
    ...vern,
    middleware: [middleware, probe, recorder, ...(vern.middleware ?? [])],
  });

  return { llm, guard: middleware, primary, b, labels, events };
}

/** A logger that records what the package says about itself, so a test can assert on it. */
export function captureLogger(): {
  logger: Logger;
  warnings: () => string[];
  errors: () => string[];
  /** Everything the logger was given, message and extra data, as one string. */
  everything: () => string;
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const all: unknown[] = [];
  const logger: Logger = {
    debug: (message) => void all.push([message]),
    warn: (message, ...rest: unknown[]) => {
      warnings.push(message);
      all.push([message, ...rest]);
    },
    error: (message, ...rest: unknown[]) => {
      errors.push(message);
      all.push([message, ...rest]);
    },
  };
  return {
    logger,
    warnings: () => warnings,
    errors: () => errors,
    everything: () => JSON.stringify(all),
  };
}

export const request: WireCallRequest = {
  model: 'primary-model',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

/**
 * Just enough of a `PreDispatchContext` to call `wrap` directly, for what a real `VernLLM` cannot
 * cause: a guard that breaks on its own. `emitted` collects the custom events.
 */
export function fakeContext(overrides: Partial<PreDispatchContext> = {}) {
  const emitted: { name: string; data: unknown }[] = [];
  const ctx = {
    stage: 'pre-dispatch',
    requestId: 'r1',
    state: createMiddlewareStateBag(),
    own: {},
    context: undefined,
    emit: (name: string, data?: unknown) => void emitted.push({ name, data }),
    ...overrides,
  } as unknown as PreDispatchContext;
  return { ctx, emitted };
}

/** Scores by category. A category counts as flagged from 0.5, the way the stub reports it. */
export type Scores = Partial<Record<ModerationCategory, number>>;

/** A moderation result with every category present. */
export function moderationResult(scores: Scores = {}): ModerationResult {
  const categories: Partial<Record<ModerationCategory, boolean>> = {};
  const category_scores: Partial<Record<ModerationCategory, number>> = {};
  for (const category of MODERATION_CATEGORIES) {
    const score = scores[category] ?? 0;
    categories[category] = score >= 0.5;
    category_scores[category] = score;
  }
  return { flagged: Object.values(categories).includes(true), categories, category_scores };
}

const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * A moderation client that scores each text with `score`, and records every request. With
 * `delayMs` it answers late and stops when its signal aborts, and `peak` says how many requests
 * were in flight at once. An `error` is thrown instead of an answer. A request of images is kept
 * apart in `images`, one entry for each, and scored with `behavior.image` from the data URL; like
 * the real API, it answers once for all the parts of one request.
 */
export function createModerationClient(
  score: (text: string) => Scores = () => ({}),
  behavior: { delayMs?: number; error?: Error; image?: (url: string) => Scores } = {},
) {
  const calls: { model: string; input: string[]; signal: AbortSignal | undefined }[] = [];
  const images: { model: string; url: string; parts: number; signal: AbortSignal | undefined }[] =
    [];
  let active = 0;
  let peak = 0;

  const client: ModerationClient = {
    moderations: {
      create: async (body, options) => {
        const input = body.input as (string | ModerationImagePart)[];
        const parts = input.filter((part): part is ModerationImagePart => typeof part !== 'string');
        if (parts.length > 0) {
          images.push({
            model: body.model,
            url: parts[0]!.image_url.url,
            parts: parts.length,
            signal: options?.signal,
          });
        } else {
          calls.push({
            model: body.model,
            input: [...(input as string[])],
            signal: options?.signal,
          });
        }
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (behavior.delayMs !== undefined) await pause(behavior.delayMs, options?.signal);
          if (behavior.error) throw behavior.error;
          if (parts.length > 0) {
            const scores = parts.map((part) => behavior.image?.(part.image_url.url));
            return { results: [moderationResult(Object.assign({}, ...scores))] };
          }
          return { results: (input as string[]).map((text) => moderationResult(score(text))) };
        } finally {
          active -= 1;
        }
      },
    },
  };

  return { client, calls, images, peak: () => peak };
}

/** What a stub classifier finds in a text: each category that applies, with its quotes. */
export type Found = Record<string, string[]>;

const TAGGED = /<(t_[0-9a-f]{6}) id="(\d+)">\n([\s\S]*?)\n<\/\1>/g;

/** The texts a classifier call was sent, in id order, and the boundary tag they came in. */
export function classifierInput(userContent: string): { boundary: string; texts: string[] } {
  const matches = [...userContent.matchAll(TAGGED)];
  const texts: string[] = [];
  for (const [, , id, text] of matches) texts[Number(id)] = text!;
  return { boundary: matches[0]?.[1] ?? '', texts };
}

/** A level for each category, 0 none to 3 high, by name. */
export type Levels = Record<string, number>;

/**
 * The answer a model would give: what `decide` finds in each text, by id. With `levels` it grades
 * every category, as a model asked for levels does, and quotes the ones it graded above zero.
 */
export function classifierAnswer(
  decide: (text: string) => Found,
  userContent: string,
  levels?: { names: readonly string[]; of: (text: string) => Levels },
): ClassifierAnswer {
  const { texts } = classifierInput(userContent);
  return {
    results: texts.map((text, id) => {
      const found = decide(text);
      if (levels === undefined) return { id, categories: Object.keys(found), quotes: found };

      const graded = Object.fromEntries(levels.names.map((name) => [name, 0]));
      Object.assign(graded, levels.of(text));
      const quotes = Object.fromEntries(levels.names.map((name) => [name, found[name] ?? []]));
      // A model asked for levels answers with them alone, and the validator derives the rest.
      return { id, levels: graded, quotes } as ClassifierAnswer['results'][number];
    }),
  };
}

/** What a `VernLLM` over a stub client answers, so a real one can act as the classifier's model. */
export const classifierResponder =
  (decide: (text: string) => Found): Responder =>
  (params) =>
    JSON.stringify(classifierAnswer(decide, lastUserText(params)));

/**
 * A model for `llmClassifier` that decides each text with `decide`, and records every call. With
 * `delayMs` it answers late and stops when its signal aborts, `peak` says how many calls were in
 * flight at once, and `answer` changes what it says. An `error` is thrown instead of an answer.
 */
export function createClassifierLLM(
  decide: (text: string) => Found = () => ({}),
  behavior: {
    delayMs?: number;
    error?: Error;
    answer?: (answer: ClassifierAnswer) => unknown;
    /** Answer with a level for every category, as a classifier with `levels: true` is asked to. */
    levels?: { names: readonly string[]; of: (text: string) => Levels };
  } = {},
) {
  const calls: (ReturnType<typeof classifierInput> & { params: CallParams<ClassifierAnswer> })[] =
    [];
  let active = 0;
  let peak = 0;

  const llm: ClassifierLLM = {
    call: async (params) => {
      const content = params.userContent as string;
      calls.push({ params, ...classifierInput(content) });
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (behavior.delayMs !== undefined) await pause(behavior.delayMs, params.signal);
        if (behavior.error) throw behavior.error;
        const answer = classifierAnswer(decide, content, behavior.levels);
        return behavior.answer ? behavior.answer(answer) : answer;
      } finally {
        active -= 1;
      }
    },
  };

  return { llm, calls, peak: () => peak };
}

/** What a guardrail answers for a text: its assessments, as the API returns them. */
export type Assessments = Record<string, unknown>[];

/**
 * A client for `bedrockGuardrail` that assesses each text with `assess`, and records every request
 * with the signal it carried. With `delayMs` it answers late and stops when its signal aborts, and
 * `peak` says how many requests were in flight at once. An `error` is thrown instead of an answer.
 */
export function createGuardrailClient(
  assess: (text: string) => Assessments = () => [],
  behavior: { delayMs?: number; error?: Error } = {},
) {
  const calls: { text: string; source: string | undefined; signal: AbortSignal | undefined }[] = [];
  let active = 0;
  let peak = 0;

  const client: GuardrailClient = {
    send: async (command, options) => {
      const { source, content } = command.input;
      const text = (content![0] as { text: { text: string } }).text.text;
      calls.push({ text, source, signal: options?.abortSignal });
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (behavior.delayMs !== undefined) await pause(behavior.delayMs, options?.abortSignal);
        if (behavior.error) throw behavior.error;
        return { assessments: assess(text) as never };
      } finally {
        active -= 1;
      }
    },
  };

  return { client, calls, peak: () => peak };
}
