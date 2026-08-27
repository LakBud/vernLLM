import type { WireMessage, WireToolChoice } from './client.js';
import type { VernLLMEvent } from './events.js';
import type { CallMeta } from './fallback.js';

/** Capabilities of the target a middleware hook is currently looking at. */
export interface MiddlewareCapabilities {
  /**
   * Whether this target honors `response_format: { type: 'json_object' }`
   * as a real constraint. Mirrors `LLMClient.supportsJsonObjectMode`.
   * `false` for `fromAnthropic` and `fromBedrock`.
   */
  supportsJsonObjectMode: boolean;
}

/**
 * A typed reference to one slot in `ctx.state`. Create one with
 * `createStateKey`, export it, and import the same reference wherever
 * another middleware needs to read or write the same value. There's no
 * string key anywhere in this path, so a typo becomes a missing import
 * or an undefined variable, a compile error, instead of a silently
 * created new property.
 */
export interface MiddlewareStateKey<T> {
  readonly debugName: string;

  /**
   * Never set at runtime; exists purely so `T` is actually used
   * somewhere in this interface's shape (a phantom type), which is what
   * lets `MiddlewareStateBag.get`/`set` infer the right type for a given
   * key instead of two `MiddlewareStateKey<string>` and
   * `MiddlewareStateKey<number>` keys being structurally identical.
   */
  readonly __phantom?: T;
}

/** Creates a new, distinct `MiddlewareStateKey`. `debugName` is used only in log lines and the `'middleware'` event; it never affects equality. */
export function createStateKey<T>(debugName: string): MiddlewareStateKey<T> {
  return { debugName };
}

/**
 * Typed, per-logical-call storage two middleware can deliberately share a
 * value through (a span ID one sets, another reads). Backed by a plain
 * `Map` internally, created once per logical call and never read or
 * written by VernLLM itself.
 */
export interface MiddlewareStateBag {
  get<T>(key: MiddlewareStateKey<T>): T | undefined;
  set<T>(key: MiddlewareStateKey<T>, value: T): void;
}

/** A plain, `Map`-backed `MiddlewareStateBag`. */
export function createMiddlewareStateBag(): MiddlewareStateBag {
  const store = new Map<MiddlewareStateKey<unknown>, unknown>();

  return {
    get<T>(key: MiddlewareStateKey<T>): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: MiddlewareStateKey<T>, value: T): void {
      store.set(key, value);
    },
  };
}

/** Fields every `MiddlewareContext` variant carries, regardless of `stage`. */
export interface MiddlewareContextBase {
  requestId: string;

  /** Capabilities of the target this stage's identity fields describe. */
  capabilities: MiddlewareCapabilities;

  signal?: AbortSignal;

  /** Shared, collision-proof state for two middleware to deliberately coordinate through. See `MiddlewareStateBag`. */
  state: MiddlewareStateBag;

  /** Simple, string-keyed scratch space, pre-namespaced to this one middleware so two middleware can never collide here even by accident. */
  own: Record<string, unknown>;
}

/**
 * The `ctx` `transform` receives, and every attempt-scoped event context
 * (`'retry'`, `'fallback'`, `'circuit_state'`, `'middleware'`). Built once
 * a specific target has actually been selected for this attempt, so every
 * field describes the real target, not a placeholder.
 */
export interface AttemptContext extends MiddlewareContextBase {
  stage: 'attempt';

  /** The target this attempt is actually dispatched to. */
  requestedProvider: string;
  requestedModel: string;
  isFallbackAttempt: boolean;

  /** The real, current attempt number for this dispatch. */
  attempt: number;
}

/**
 * The `ctx` `wrap` receives before `next()` resolves (and `onError`'s own
 * `ctx`, built the same way under the hood). Built once, before any
 * fallback target is chosen, so it only ever describes the primary
 * target — there is no real "requested" target yet, and no attempt count,
 * fallback flag, or per-attempt capability to report. Read `next()`'s
 * resolved `CallResult.meta` once you need to know what actually
 * happened.
 */
export interface PreDispatchContext extends MiddlewareContextBase {
  stage: 'pre-dispatch';

  /** The primary target only — not necessarily who ends up answering. */
  primaryProvider: string;
  primaryModel: string;
}

/**
 * `enabled` and `onEvent` are called from both stages (gating/observing
 * `transform` as well as `wrap`), so they receive this union and must
 * narrow on `ctx.stage` before reading stage-specific fields.
 * `transform` and `wrap` themselves receive the single variant that's
 * always accurate for them (`AttemptContext`/`PreDispatchContext`
 * respectively). See `VernLLMMiddleware`.
 */
export type MiddlewareContext = AttemptContext | PreDispatchContext;

/** The `response_format` shape `RequestBuilder` can put on the wire. */
export type WireResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
        description?: string;
      };
    };

/** A tool as it appears on the wire, OpenAI's `function`-wrapped shape. */
export interface WireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The wire-shaped request `RequestBuilder.build()` produces for one call
 * attempt, before dispatch. Read only inside `transform`; return a patch
 * of the fields you want to change instead of the whole object.
 */
export interface WireCallRequest {
  model: string;
  temperature?: number;
  max_tokens: number;
  response_format?: WireResponseFormat;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  budget_tokens?: number;
  tools?: WireTool[];
  tool_choice?: WireToolChoice;
  messages: WireMessage[];
}

/**
 * What `transform` returns: a patch merged onto the request that
 * `RequestBuilder.build()` (plus every earlier middleware's own patch)
 * already produced, not a replacement for it. `model` and
 * `response_format` can't be expressed here at all, since everything
 * downstream that attributes a call to a target keys off the values
 * `RequestBuilder` already resolved for those two fields, not off
 * whatever ends up on the wire request. `messages`/`tools` are joined by
 * a separate `add*` field, appended rather than replaced, so two
 * independently written middleware can each add to the list without one
 * silently clobbering what the other already added.
 */
export interface WireCallRequestPatch {
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  budget_tokens?: number;
  tool_choice?: WireToolChoice;

  /** Replaces the whole message list. Prefer `addMessages` unless a full replace is genuinely the intent. */
  messages?: WireMessage[];
  /** Appended after whatever earlier middleware already added. Never clobbers a prior addition. */
  addMessages?: WireMessage[];

  /** Replaces the whole tool list. Prefer `addTools`, same reasoning as `messages`/`addMessages`. */
  tools?: WireTool[];
  /** Appended after whatever earlier middleware already added. Never clobbers a prior addition. */
  addTools?: WireTool[];
}

/**
 * The settled outcome of one logical call, passed to `wrap`'s `next()`.
 * `meta` is populated once a target has actually answered, for both
 * streaming and non-streaming calls (`undefined` only on a cache hit,
 * where nothing was actually spent).
 */
export interface CallResult<T = unknown> {
  value: T;
  meta?: CallMeta;
}

/**
 * One entry in `VernLLMOptions.middleware`. All four hooks are optional;
 * an entry that sets none of them is inert. See the middleware docs for
 * how `transform`, `wrap`, `onEvent`, and `enabled` compose across
 * several entries.
 */
export interface VernLLMMiddleware {
  /** Used in log lines and the `'middleware'` event. Defaults to this entry's array position when omitted. */
  name?: string;
  /** Sort key for composition order, ascending, ties broken by array order. See the middleware docs for what "lower runs first" means for `wrap`. */
  priority?: number;

  /**
   * Boolean for a static on/off switch, or a predicate evaluated per
   * call. A throwing, rejecting, or timed-out predicate is logged and
   * treated as `false` for that call.
   */
  enabled?: boolean | ((ctx: MiddlewareContext) => boolean | Promise<boolean>);

  /** Per-middleware override of the instance-level `middlewareTimeoutMs`, applied to this entry's `transform` and function `enabled`. `<= 0` means unbounded (no timer at all). */
  timeoutMs?: number;

  /** Transforms the outgoing wire request for one attempt. Runs once per attempt, including retries. `ctx` is always accurate to the real target for this attempt. */
  transform?: (
    request: Readonly<WireCallRequest>,
    ctx: AttemptContext,
  ) => WireCallRequestPatch | Promise<WireCallRequestPatch>;

  /**
   * Wraps one whole logical call, exactly once, regardless of how many
   * retries or fallback targets ran underneath it. `ctx` is built once,
   * before any fallback target is chosen, so it only describes the
   * primary target — there is no `requestedProvider`/`isFallbackAttempt`/
   * `attempt` to read here. Read `next()`'s resolved `CallResult.meta`
   * for what actually happened.
   */
  wrap?: (
    request: Readonly<WireCallRequest>,
    next: () => Promise<CallResult>,
    ctx: PreDispatchContext,
  ) => Promise<CallResult>;

  /** Observes the same events reported on `VernLLMOptions.onEvent`, filtered by this middleware's own `enabled`. Called from both stages; narrow on `ctx.stage` before reading stage-specific fields. */
  onEvent?: (event: VernLLMEvent, ctx: MiddlewareContext) => void;
}
