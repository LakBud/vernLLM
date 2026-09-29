import { isJson, type CallScope } from '../../../utils/callScope.utils.js';
import { emitEvent } from './middleware.utils.js';

import type { Logger } from '../../../../logger.js';
import type { CallContext, VernLLMEvent, VernLLMMiddleware } from '../../../../types/index.js';

/** The most `custom` events one call delivers. Anything past it is dropped, with one warning. */
export const MAX_CUSTOM_EVENTS_PER_CALL = 100;

/** What `createCallScope` needs to deliver an event, all of it fixed for the instance. */
export interface CallScopeDependencies {
  reportEvent: (event: VernLLMEvent) => void;
  /** Already in `onEvent` order. */
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  logger: Logger;
}

type DropReason = 'invalid' | 'reentrant' | 'limit';

/**
 * The scope for one logical call, holding its `context`. `emitCustom` validates the event and delivers it through the
 * same `emitEvent` every other event uses, so it reaches `onEvent` and every enabled
 * middleware's `onEvent`, the emitter included.
 *
 * A handler can emit from inside `onEvent`, so two guards keep that from looping: an emit made
 * synchronously while a custom event is being delivered is dropped, and a call delivers at most
 * `MAX_CUSTOM_EVENTS_PER_CALL`. The second also covers a loop through an async `enabled`, whose
 * delivery is deferred and so escapes the first. Each drop is warned once per call.
 */
export function createCallScope(
  dependencies: CallScopeDependencies,
  context: CallContext | undefined,
): CallScope {
  const { reportEvent, middleware, middlewareTimeoutMs, logger } = dependencies;

  let delivered = 0;
  let delivering = false;
  const warned = new Set<DropReason>();

  return {
    context,
    emitCustom(name, data, source, ctx) {
      const drop = (reason: DropReason, message: string): void => {
        if (warned.has(reason)) return;

        warned.add(reason);
        logger.warn(`[VernLLM:${ctx.requestId}] middleware "${source}" ${message}`);
      };

      if (!isValidCustomEvent(name, data)) {
        drop(
          'invalid',
          'called ctx.emit with an empty name or data that is not plain JSON, dropping the event',
        );
        return;
      }

      if (delivering) {
        drop(
          'reentrant',
          `emitted "${name}" while a custom event was being delivered, dropping it`,
        );
        return;
      }

      if (delivered >= MAX_CUSTOM_EVENTS_PER_CALL) {
        drop(
          'limit',
          `emitted more than ${MAX_CUSTOM_EVENTS_PER_CALL} custom events in one call, dropping the rest`,
        );
        return;
      }

      delivered++;
      delivering = true;

      try {
        emitEvent(
          {
            kind: 'custom',
            requestId: ctx.requestId,
            name,
            source,
            ...(data === undefined ? {} : { data }),
          },
          ctx,
          reportEvent,
          middleware,
          middlewareTimeoutMs,
          logger,
        );
      } finally {
        delivering = false;
      }
    },
  };
}

/** `data` may be absent. A throw, from data nested deep enough to overflow the stack, is invalid. */
function isValidCustomEvent(name: unknown, data: unknown): boolean {
  if (typeof name !== 'string' || name === '') return false;

  try {
    return data === undefined || isJson(data);
  } catch {
    return false;
  }
}
