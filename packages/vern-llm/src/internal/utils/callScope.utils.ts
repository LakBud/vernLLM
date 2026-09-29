import { LLMError } from '../../types/errors.js';

import type { CallContext, JsonValue } from '../../types/call.js';
import type {
  MiddlewareContext,
  MiddlewareContextBase,
  MiddlewareStateBag,
  MiddlewareStateEntry,
} from '../../types/middleware.js';

/**
 * Per call machinery a middleware reaches through `ctx` but must not be able to read or replace,
 * so it is kept off the state bag, the same way `ownStores` is in `middleware.utils.ts`.
 */
export interface CallScope {
  /** The call's validated, frozen `context`. `undefined` when none was given. */
  context: CallContext | undefined;

  /** Reports a `custom` event. Never throws. See `createCallScope`. */
  emitCustom: (
    name: string,
    data: JsonValue | undefined,
    source: string,
    ctx: MiddlewareContext,
  ) => void;
}

/** One scope per logical call, keyed by that call's state bag. */
const scopes = new WeakMap<MiddlewareStateBag, CallScope>();

/**
 * Attaches `scope` to a call's state bag. A second registration is ignored, since the inner call
 * of `cachedCall` reuses the bag the outer one already registered.
 */
export function registerCallScope(state: MiddlewareStateBag, scope: CallScope): void {
  if (!scopes.has(state)) scopes.set(state, scope);
}

/** The call's scope, or `undefined` for a bag made outside a call, like a manual `openCircuit()`. */
export function callScopeFor(state: MiddlewareStateBag): CallScope | undefined {
  return scopes.get(state);
}

/** The `emit` a freshly built context carries until `withOwn` binds it to a middleware. */
export const noopEmit: MiddlewareContextBase['emit'] = () => {};

/** A plain `{}` or `Object.create(null)` object, not a class instance, `Date`, `Map` and so on. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `value` is plain JSON: plain objects, arrays, strings, finite numbers, booleans and
 * `null`. `undefined`, functions, symbols, `NaN`, `Infinity` and class instances are rejected.
 *
 * `ancestors` holds only the objects on the current path, so a cycle is rejected while a value
 * shared by two branches is not.
 */
export function isJson(value: unknown, ancestors: Set<object> = new Set()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);

  // `Array.from` visits the holes of a sparse array as `undefined`, which are then rejected.
  const items = Array.isArray(value)
    ? Array.from(value as unknown[])
    : isPlainObject(value)
      ? Object.values(value)
      : undefined;

  if (items === undefined || ancestors.has(value as object)) return false;

  ancestors.add(value as object);

  const valid = items.every((item) => isJson(item, ancestors));

  ancestors.delete(value as object);

  return valid;
}

/** Freezes `value` and everything inside it. Only ever handed plain JSON, so it always ends. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }

  return value;
}

/**
 * Validates, clones and deep freezes a call's `context`. The clone means a caller mutating its
 * own object mid call can't change what middleware read. Throws `invalid_params` for anything
 * that isn't a plain JSON object.
 */
export function prepareCallContext(value: unknown): CallContext | undefined {
  if (value === undefined) return undefined;

  // Data nested deep enough to overflow the stack is as invalid as a cycle.
  let valid = false;

  try {
    valid = isPlainObject(value) && isJson(value);
  } catch {
    valid = false;
  }

  if (!valid) {
    throw new LLMError('`context` must be a plain JSON object', 'invalid_params', {
      code: 'invalid_context',
    });
  }

  return deepFreeze(structuredClone(value as CallContext));
}

/**
 * A `[key, value]` pair whose key looks like one made by `createStateKey`. `MiddlewareStateKey` is
 * a type level brand, so the only runtime trace of one is its string `debugName`.
 */
function isStateEntry(entry: unknown): entry is MiddlewareStateEntry {
  if (!Array.isArray(entry) || entry.length !== 2) return false;

  const key: unknown = entry[0];

  return (
    typeof key === 'object' &&
    key !== null &&
    typeof (key as { debugName?: unknown }).debugName === 'string'
  );
}

/**
 * Checks that `state` is an array of `[key, value]` pairs, so a malformed entry fails here instead
 * of seeding a key nothing can read. Throws a plain `invalid_params`, with no `code`, since it
 * only happens when a caller bypasses the types.
 */
export function validateStateEntries(state: unknown): readonly MiddlewareStateEntry[] | undefined {
  if (state === undefined) return undefined;

  if (!Array.isArray(state) || !state.every(isStateEntry)) {
    throw new LLMError(
      '`state` must be an array of [key, value] pairs, with keys made by createStateKey',
      'invalid_params',
    );
  }

  return state;
}
