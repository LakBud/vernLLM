import type { CallContext, JsonValue } from './call.js';
import type { AdapterInfo, WireMessage, WireToolChoice } from './client.js';
import type { VernLLMEvent } from './events.js';
import type { CallMeta, TargetInfo } from './fallback.js';

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
 * The `{ debugName }` shape shared by state keys and middleware refs, before each adds its own
 * brand.
 */
function createIdentityToken(debugName: string): { debugName: string } {
  return { debugName };
}

/**
 * Brands `MiddlewareStateKey` so a ref, or a hand written `{ debugName }`, can't pass as a state
 * key. Only `createStateKey` can produce one.
 */
declare const stateKeyBrand: unique symbol;

/**
 * A typed reference to one slot in `ctx.state`. Create it with `createStateKey` and import it
 * wherever the value is shared, so a typo is a compile error instead of a new property.
 */
export interface MiddlewareStateKey<T> {
  readonly debugName: string;
  readonly [stateKeyBrand]: true;

  /**
   * Never set. Makes keys of different `T` distinct types, so `get` and `set` infer the value type.
   */
  readonly __phantom?: T;
}

/** Creates a new, distinct `MiddlewareStateKey`. `debugName` is used only in log lines and the `'middleware'` event; it never affects equality. */
export function createStateKey<T>(debugName: string): MiddlewareStateKey<T> {
  return createIdentityToken(debugName) as MiddlewareStateKey<T>;
}

/** Not exported. See `stateKeyBrand`; same reasoning, distinct symbol, so the two token types can't be cross-assigned either. */
declare const middlewareRefBrand: unique symbol;

/**
 * A typed reference to a middleware, used only as a `runsAfter` or `runsBefore` target, never as a
 * label. Create it with `createMiddlewareRef` and export it, so a typo is a compile error.
 */
export interface MiddlewareRef {
  readonly debugName: string;
  readonly [middlewareRefBrand]: true;
}

/** Creates a new, distinct `MiddlewareRef`. `debugName` is used only in error messages when a reference doesn't resolve; it never affects equality, so two refs with the same `debugName` never collide. */
export function createMiddlewareRef(debugName: string): MiddlewareRef {
  return createIdentityToken(debugName) as MiddlewareRef;
}

/**
 * A `runsAfter` or `runsBefore` entry, made with `requireRef`, that throws at construction when the
 * target isn't registered. A bare ref is optional and only warns.
 */
export interface RequiredMiddlewareRef {
  readonly ref: MiddlewareRef;
}

/** Wraps `ref` so `runsAfter`/`runsBefore` throws at `VernLLM` construction time if it doesn't resolve, instead of warning and continuing. */
export function requireRef(ref: MiddlewareRef): RequiredMiddlewareRef {
  return { ref };
}

/**
 * Typed per call storage that middleware share values through. VernLLM never reads or writes it.
 */
export interface MiddlewareStateBag {
  get<T>(key: MiddlewareStateKey<T>): T | undefined;
  set<T>(key: MiddlewareStateKey<T>, value: T): void;
}

/**
 * One `[key, value]` pair for a call's `state`. A tuple can't tie each value to its own key's type,
 * so `stateEntry` carries that check. Raw pairs are not type checked.
 */
export type MiddlewareStateEntry = readonly [MiddlewareStateKey<unknown>, unknown];

/** Builds a type checked `state` entry: `value` must match the key's type. */
export function stateEntry<T>(key: MiddlewareStateKey<T>, value: T): MiddlewareStateEntry {
  return [key, value];
}

/** A plain, `Map`-backed `MiddlewareStateBag`, optionally seeded with `entries`. Later entries win. */
export function createMiddlewareStateBag(
  entries?: readonly MiddlewareStateEntry[],
): MiddlewareStateBag {
  const store = new Map<MiddlewareStateKey<unknown>, unknown>(entries);

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

  /**
   * Every registered middleware's label, in `transform` order, e.g. to skip work another known
   * middleware already does.
   */
  registeredMiddlewareNames: readonly string[];

  /**
   * The labels from `registeredMiddlewareNames` whose entry defines a
   * `transform`, in the same order, frozen. Lets a middleware tell
   * whether any entry after it can still change the request.
   */
  transformMiddlewareNames: readonly string[];

  /** Reports a `custom` event to `onEvent` and every middleware. Never throws. */
  emit(name: string, data?: JsonValue): void;

  /** The call's `context`, frozen. `undefined` when none was given. */
  context: CallContext | undefined;
}

/**
 * The `ctx` for `transform` and every attempt scoped event. Built once a target is selected, so
 * every field describes the real target.
 */
export interface AttemptContext extends MiddlewareContextBase {
  stage: 'attempt';

  /** The target this attempt is actually dispatched to. */
  requestedProvider: string;
  /** The adapter behind this target. `{ name: 'custom' }` when its client doesn't identify one. */
  adapter: AdapterInfo;
  requestedModel: string;
  isFallbackAttempt: boolean;

  /**
   * The current attempt number. A `'circuit_state'` event from the check before any attempt reports
   * 1.
   */
  attempt: number;
}

/**
 * The `ctx` for `wrap` and `onError`. Built before any target is chosen, so it only describes the
 * primary. Read `next()`'s `CallResult.meta` for what happened.
 */
export interface PreDispatchContext extends MiddlewareContextBase {
  stage: 'pre-dispatch';

  /** The primary target only, not necessarily who ends up answering. */
  primaryProvider: string;
  /** The adapter behind the primary target. `{ name: 'custom' }` when its client doesn't identify one. */
  primaryAdapter: AdapterInfo;
  primaryModel: string;

  /** The order so far: what this `wrap` may try, after every outer `wrap` narrowed it. */
  targets: readonly TargetInfo[];
}

/**
 * What `enabled` and `onEvent` receive, since they run in both stages. Narrow on `ctx.stage` before
 * reading stage specific fields.
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
 * A patch `transform` returns, merged onto the built request. `model` and `response_format` can't
 * be patched, since targets are attributed by the values already resolved. `add*` fields append, so
 * two middleware can add without overwriting each other.
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
 * The settled outcome of one logical call, from `wrap`'s `next()`. `meta` is `undefined` only on a
 * cache hit.
 */
export interface CallResult<T = unknown> {
  value: T;
  meta?: CallMeta;
}

/**
 * One entry in `VernLLMOptions.middleware`. Every hook is optional. See the middleware docs for how
 * hooks compose.
 */
export interface VernLLMMiddleware {
  /** Used in log lines and the `'middleware'` event. Defaults to this entry's array position when omitted. */
  name?: string;

  /**
   * This entry's identity for other entries' `runsAfter` and `runsBefore`. Unrelated to `name`,
   * which is only a label.
   */
  ref?: MiddlewareRef;

  /** Sort key for composition order, ascending, ties broken by array order. See the middleware docs for what "lower runs first" means for `wrap`. */
  priority?: number;

  /**
   * Middleware this entry runs after. An unresolved bare ref is dropped; wrap it with `requireRef`
   * to throw at construction instead. A cycle always throws.
   */
  runsAfter?: (MiddlewareRef | RequiredMiddlewareRef)[];

  /**
   * Other middleware this entry must run before. See `runsAfter`; a
   * bare reference is dropped if unresolved, a `requireRef`-wrapped one
   * throws.
   */
  runsBefore?: (MiddlewareRef | RequiredMiddlewareRef)[];

  /**
   * Pins this entry in `wrap` nesting only. `'outermost'` sees the net result of every retry and
   * fallback; `'innermost'` sits next to dispatch. A number works like `priority` for `wrap` only.
   */
  position?: 'outermost' | 'innermost' | number;

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
   * Wraps one whole logical call once, however many retries or targets ran. `ctx` describes the
   * primary and the order so far (`ctx.targets`); read `next()`'s `CallResult.meta` for what
   * happened. `next({ targets })` reorders or drops targets by name, never adds one.
   */
  wrap?: (
    request: Readonly<WireCallRequest>,
    next: (options?: { targets?: readonly string[] }) => Promise<CallResult>,
    ctx: PreDispatchContext,
  ) => Promise<CallResult>;

  /**
   * Wraps one attempt's provider request, after the limiter and every `transform`. `request` is
   * exactly what the adapter gets. Runs per attempt, nested in `wrap` order.
   *
   * `next()` resolves when the response arrives, or at a stream's first content chunk; pings don't
   * count. It rejects with the attempt's `LLMError`. A hook can observe but not change the outcome:
   * returning or throwing without calling `next()` fails the attempt with code `middleware_threw`,
   * and a throw after it is only logged.
   */
  dispatch?: (
    request: Readonly<WireCallRequest>,
    next: () => Promise<void>,
    ctx: AttemptContext,
  ) => Promise<void>;

  /** Observes the same events reported on `VernLLMOptions.onEvent`, filtered by this middleware's own `enabled`. Called from both stages; narrow on `ctx.stage` before reading stage-specific fields. */
  onEvent?: (event: VernLLMEvent, ctx: MiddlewareContext) => void;
}
