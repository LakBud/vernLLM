import {
  LLMError,
  type MiddlewareContext,
  type VernLLMEvent,
  type VernLLMMiddleware,
  type WireCallRequest,
  type WireCallRequestPatch,
} from '../../../types/index.js';
import { normalizeError } from './errors.utils.js';

import type { Logger } from '../../../logger.js';

/** Default `middlewareTimeoutMs`, used both as `VernLLMOptions`'s own default and as the instance-level bound `CallExecutor` falls back to when none is passed in. Bounds `transform` and a function `enabled`; `wrap` itself is never bounded by this. */
export const DEFAULT_MIDDLEWARE_TIMEOUT_MS = 5000;

/** `middleware.name`, or its array position if unnamed. Used in log lines and the `'middleware'` event. */
export function middlewareLabel(middleware: VernLLMMiddleware, index: number): string {
  return middleware.name ?? `[${index}]`;
}

/**
 * Races `fn()` against a timer, resolving/rejecting with whichever
 * settles first. Unlike `withTimeout` elsewhere in the package,
 * `transform` and a function `enabled` don't take a signal to
 * cooperatively abort on (their signature is `(ctx) => ...`, not
 * `(signal) => ...`), so a plain `Promise.race` is what actually bounds
 * them; a middleware that never resolves keeps running in the
 * background, but its result is no longer awaited past `timeoutMs`.
 *
 * The rejection is built with `code: 'middleware_timeout'`, a distinct
 * identity from the provider's own `request_timeout`: it names `label`
 * so `reclassifyMiddlewareThrow` (which only relabels truly
 * unrecognized throws) doesn't need to guess which middleware timed
 * out, and it's excluded from the general `timeout` type's
 * retryability so `computeRetryable` doesn't retry a `transform` that's
 * just going to time out again the same way.
 */
function raceTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new LLMError(`middleware "${label}" timed out after ${timeoutMs}ms`, 'timeout', {
          code: 'middleware_timeout',
        }),
      );
    }, timeoutMs);

    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolves a middleware's `enabled` for one call. A throwing, rejecting,
 * or timed-out predicate is logged and treated as `false`: a middleware
 * that couldn't decide whether it applies is indistinguishable, from the
 * caller's perspective, from one that decided "no."
 */
export async function resolveEnabled(
  middleware: VernLLMMiddleware,
  ctx: MiddlewareContext,
  label: string,
  middlewareTimeoutMs: number,
  logger: Logger,
): Promise<boolean> {
  const { enabled } = middleware;

  if (enabled === undefined) return true;
  if (typeof enabled === 'boolean') return enabled;

  const timeoutMs = middleware.timeoutMs ?? middlewareTimeoutMs;

  try {
    return await raceTimeout(async () => enabled(ctx), timeoutMs, label);
  } catch (error) {
    logger.error(
      `[VernLLM] middleware "${label}".enabled threw or timed out, treating as disabled`,
      {
        message: error instanceof Error ? error.message : 'unknown',
      },
    );
    return false;
  }
}

const PATCH_FIELDS: (keyof WireCallRequestPatch)[] = [
  'temperature',
  'max_tokens',
  'reasoning_effort',
  'budget_tokens',
  'tool_choice',
  'messages',
  'addMessages',
  'tools',
  'addTools',
];

/**
 * Merges one middleware's `transform` patch onto the request as merged so
 * far. `addMessages`/`addTools` are appended, never replace; everything
 * else is a plain overwrite. Returns the merged request and which
 * top-level fields the patch actually touched, for the `'middleware'`
 * trace event.
 */
export function mergePatch(
  request: WireCallRequest,
  patch: WireCallRequestPatch,
): { request: WireCallRequest; patchedFields: string[] } {
  // `model`/`response_format` aren't declared on `WireCallRequestPatch`
  // at all, so a well-typed `transform` can't produce them. A caller who
  // bypasses the type system (plain JS, `as any`) can still put them on
  // the returned object; copy them through here so
  // `assertModelAndResponseFormatUnchanged` actually has something to
  // catch, instead of silently dropping the bypass before the backstop
  // guard ever runs.
  const rawPatch = patch as WireCallRequestPatch & {
    model?: unknown;
    response_format?: unknown;
  };

  const patchedFields: string[] = PATCH_FIELDS.filter((field) => patch[field] !== undefined);
  if (rawPatch.model !== undefined) patchedFields.push('model');
  if (rawPatch.response_format !== undefined) patchedFields.push('response_format');

  if (patchedFields.length === 0) {
    return { request, patchedFields: [] };
  }

  const next: WireCallRequest = { ...request };

  if (rawPatch.model !== undefined) next.model = rawPatch.model as string;
  if (rawPatch.response_format !== undefined) {
    next.response_format = rawPatch.response_format as WireCallRequest['response_format'];
  }

  if (patch.temperature !== undefined) next.temperature = patch.temperature;
  if (patch.max_tokens !== undefined) next.max_tokens = patch.max_tokens;
  if (patch.reasoning_effort !== undefined) next.reasoning_effort = patch.reasoning_effort;
  if (patch.budget_tokens !== undefined) next.budget_tokens = patch.budget_tokens;
  if (patch.tool_choice !== undefined) next.tool_choice = patch.tool_choice;

  if (patch.messages !== undefined) {
    next.messages = patch.messages;
  }
  if (patch.addMessages !== undefined && patch.addMessages.length > 0) {
    next.messages = [...next.messages, ...patch.addMessages];
  }

  if (patch.tools !== undefined) {
    next.tools = patch.tools;
  }
  if (patch.addTools !== undefined && patch.addTools.length > 0) {
    next.tools = [...(next.tools ?? []), ...patch.addTools];
  }

  return { request: next, patchedFields };
}

/** Throws `LLMError('invalid_params')` naming `label` if `merged.tools` has a duplicate name, run right after the addTools merge that could have introduced one. */
export function assertNoDuplicateTools(request: WireCallRequest, label: string): void {
  if (!request.tools) return;

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const tool of request.tools) {
    if (seen.has(tool.function.name)) duplicates.add(tool.function.name);
    seen.add(tool.function.name);
  }

  if (duplicates.size > 0) {
    throw new LLMError(
      `middleware "${label}" added tool(s) with duplicate name(s): [${[...duplicates].join(', ')}]. Tool names must be unique.`,
      'invalid_params',
      { code: 'duplicate_tool_names', issues: { names: [...duplicates] } },
    );
  }
}

/** Backstop for callers who bypass the type system: `transform` can't express a change to `model`/`response_format` in TypeScript, this catches it at runtime for `any`/plain-JS callers. */
export function assertModelAndResponseFormatUnchanged(
  before: WireCallRequest,
  after: WireCallRequest,
  label: string,
): void {
  if (after.model !== before.model) {
    throw new LLMError(
      `middleware "${label}" changed \`model\` via transform, which isn't supported. Configure the target's model instead.`,
      'invalid_params',
    );
  }

  if (JSON.stringify(after.response_format) !== JSON.stringify(before.response_format)) {
    throw new LLMError(
      `middleware "${label}" changed \`response_format\` via transform, which isn't supported.`,
      'invalid_params',
    );
  }
}

/**
 * Runs a middleware's `transform`, bounded by its own or the instance
 * `middlewareTimeoutMs`. Any thrown value is passed through
 * `normalizeError` first (rule 1 of middleware error handling): a
 * recognizable status/network signal keeps its own classification, and
 * only a genuinely unrecognizable throw is reclassified to
 * `invalid_params`, naming the offending middleware.
 */
export async function runTransform(
  middleware: VernLLMMiddleware,
  request: Readonly<WireCallRequest>,
  ctx: MiddlewareContext,
  label: string,
  middlewareTimeoutMs: number,
): Promise<WireCallRequestPatch> {
  if (!middleware.transform) return {};

  const timeoutMs = middleware.timeoutMs ?? middlewareTimeoutMs;

  try {
    return await raceTimeout(async () => middleware.transform!(request, ctx), timeoutMs, label);
  } catch (error) {
    throw reclassifyMiddlewareThrow(error, label, ctx.signal);
  }
}

/**
 * Implements rule 1 of middleware error handling: a non-`LLMError` throw
 * is passed through `normalizeError`, and only reclassified to
 * `invalid_params` when `normalizeError` couldn't recognize anything
 * about it at all (`type: 'unknown'`). An already-typed `LLMError`, or a
 * plain throw `normalizeError` recognizes as a real status or network
 * signal, passes through with its own classification intact (rule 2).
 */
export function reclassifyMiddlewareThrow(
  error: unknown,
  label: string,
  signal?: AbortSignal,
): LLMError {
  const normalized = normalizeError(error, signal);

  if (normalized.type !== 'unknown') {
    return normalized;
  }

  return new LLMError(`middleware "${label}" threw: ${normalized.message}`, 'invalid_params', {
    code: 'middleware_threw',
    cause: error,
  });
}

/** Reports a `'middleware'` event through the same `onEvent` plumbing every other event uses, filtered by this middleware's own `enabled` state (the caller already resolved that before calling this). */
export function reportMiddlewareEvent(
  onEvent: ((event: VernLLMEvent) => void) | undefined,
  event: Extract<VernLLMEvent, { kind: 'middleware' }>,
): void {
  onEvent?.(event);
}
