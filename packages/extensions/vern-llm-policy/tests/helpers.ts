import {
  VernLLM,
  type LLMClient,
  type MiddlewareStateKey,
  type Logger,
  type PreDispatchContext,
  type TargetInfo,
  type VernLLMMiddleware,
  type VernLLMOptions,
  type WireCallRequest,
} from 'vern-llm';
import { vi } from 'vitest';

import { policyFlags, policyMiddleware, type PolicyOptions } from '../src/index.js';

// Copied from the other extension packages on purpose, so the packages stay independent of each
// other and of the core's own test files.

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string): CreateResult {
  return { choices: [{ message: { content: text } }] };
}

/** Each entry is a response or an error for that call. Calls past the end reuse the last entry. */
export function createMockClient(script: (CreateResult | Error)[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams) => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          /* v8 ignore next */
          if (entry === undefined) throw new Error('createMockClient: script is empty');
          if (entry instanceof Error) throw entry;
          return entry;
        },
      },
    },
  };

  return { client, calls };
}

/** A logger that records what the package says about itself, so a test can assert on it. */
export function captureLogger(): {
  logger: Logger;
  warnings: () => string[];
  errors: () => string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    warn: (message) => {
      warnings.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };
  return { logger, warnings: () => warnings, errors: () => errors };
}

/**
 * Three targets named `primary`, `b` and `c`, each with its own mock client. Spread `options` into
 * `new VernLLM`. `tried` reports which targets were contacted, in order.
 */
export function targetChain(
  scripts: {
    primary?: (CreateResult | Error)[];
    b?: (CreateResult | Error)[];
    c?: (CreateResult | Error)[];
  } = {},
) {
  const tried: string[] = [];
  const make = (name: string, script: (CreateResult | Error)[] | undefined) => {
    const mock = createMockClient(script ?? [textResponse(name)]);
    const create = mock.client.chat.completions.create;
    mock.client.chat.completions.create = (async (...args: Parameters<typeof create>) => {
      tried.push(name);
      return create(...args);
    }) as typeof create;
    return mock;
  };
  const primary = make('primary', scripts.primary);
  const b = make('b', scripts.b);
  const c = make('c', scripts.c);

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

  return { primary, b, c, options, tried: () => tried };
}

/**
 * A middleware that sits inside policy and records the target names it is offered, in order. What
 * it sees is what policy left for everything inside it.
 */
export function targetProbe(order: string[] = []): {
  middleware: VernLLMMiddleware;
  seen: string[][];
  flags: Record<string, boolean>[];
} {
  const seen: string[][] = [];
  const flags: Record<string, boolean>[] = [];
  const middleware: VernLLMMiddleware = {
    name: 'probe',
    position: 0,
    wrap: (_request, next, ctx) => {
      order.push('inside');
      seen.push(ctx.targets.map((target) => target.name));
      flags.push({ ...policyFlags(ctx) });
      return next();
    },
  };
  return { middleware, seen, flags };
}

/** Collects the custom events middleware emit, and notes each one in `order`. */
export function eventProbe(order: string[] = []): {
  middleware: VernLLMMiddleware;
  events: { name: string; data: unknown }[];
} {
  const events: { name: string; data: unknown }[] = [];
  const middleware: VernLLMMiddleware = {
    name: 'events',
    onEvent: (event) => {
      if (event.kind !== 'custom') return;
      order.push(`event:${event.name}`);
      events.push({ name: event.name, data: event.data });
    },
  };
  return { middleware, events };
}

/**
 * A real `VernLLM` over three mock targets, with policy outermost and a probe just inside it.
 * `tried` reports which providers were contacted, and `probe.seen` what policy left the probe.
 */
export function harness(
  policy: PolicyOptions = {},
  scripts: Parameters<typeof targetChain>[0] = {},
  vern: Partial<VernLLMOptions> = {},
) {
  const chain = targetChain(scripts);
  const order: string[] = [];
  const probe = targetProbe(order);
  const eventsProbe = eventProbe(order);
  const middleware = policyMiddleware({ logger: 'silent', ...policy });
  const llm = new VernLLM({
    ...chain.options,
    ...vern,
    middleware: [middleware, probe.middleware, eventsProbe.middleware],
  });
  return {
    llm,
    policy: middleware,
    chain,
    probe,
    tried: chain.tried,
    events: eventsProbe.events,
    order,
  };
}

/** An error the core reads as a provider outage, so a fallback is tried. */
export function serverError(): Error {
  return Object.assign(new Error('server error'), { status: 500 });
}

export const request: WireCallRequest = {
  model: 'primary-model',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

/**
 * Just enough of a `PreDispatchContext` to call `wrap` directly, for what a real `VernLLM` cannot
 * show: whether `next` ran synchronously, and with what.
 */
export function fakeContext(
  overrides: Partial<PreDispatchContext> & { targetNames?: string[] } = {},
): PreDispatchContext {
  const { targetNames = ['primary', 'b', 'c'], ...rest } = overrides;
  const store = new Map<unknown, unknown>();
  const targets: TargetInfo[] = targetNames.map((name, index) => ({
    name,
    index,
    model: `${name}-model`,
    adapter: { name: 'custom' },
  }));

  return {
    stage: 'pre-dispatch',
    requestId: 'req-1',
    primaryProvider: 'primary',
    primaryAdapter: { name: 'custom' },
    primaryModel: 'primary-model',
    targets,
    capabilities: { supportsJsonObjectMode: true },
    state: {
      get: <T>(key: MiddlewareStateKey<T>) => store.get(key) as T | undefined,
      set: (key, value) => void store.set(key, value),
    },
    own: {},
    registeredMiddlewareNames: [],
    transformMiddlewareNames: [],
    emit: () => undefined,
    context: undefined,
    ...rest,
  };
}

/**
 * Holds the primary's answer until `release` is called, so a call can be in flight. `reached`
 * settles once a call is waiting there, which is proof its policy has already decided.
 */
export function gate(client: LLMClient) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const create = client.chat.completions.create;
  const gated: LLMClient = {
    chat: {
      completions: {
        create: (async (...args: Parameters<typeof create>) => {
          reached();
          await open;
          return create(...args);
        }) as typeof create,
      },
    },
  };
  return { gated, release, arrived };
}

/** Waits, a macrotask at a time, until `condition` holds. A hang ends at the test timeout. */
export async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
}
