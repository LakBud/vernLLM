import { usageStateKey } from '../../logFields.js';
import { andThen, type MaybePromise } from '../maybePromise.utils.js';
import { nanoToUsd } from '../pricing/charge.utils.js';
import { attributionOf } from '../totals/attribution.utils.js';

import type { BudgetGate, Reservation } from '../budgets/gate.js';
import type { BudgetWarnings } from '../budgets/warnings.js';
import type { Guard } from '../guard.utils.js';
import type { SavedSpend } from '../pricing/savedSpend.utils.js';
import type { CallRecorder } from '../recorder/callRecorder.js';
import type { TotalsRegistry } from '../totals/totalsRegistry.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/** Everything `finish` needs to end one call. */
export interface Call {
  recorder: CallRecorder;
  request: Readonly<WireCallRequest>;
  ctx: PreDispatchContext;
  /** `undefined` when no budget applies, or the store failed and the call went unmetered. */
  reservation: Reservation | undefined;
}

export interface CallFinisher {
  /**
   * Ends the call once: publishes its cost for the logger, adds it to the totals, replaces the
   * estimate with the real spend, and warns. Nothing past the first two steps runs before the
   * logger could read `ctx.state`, which is why those come first and are synchronous. Never throws.
   */
  finish(
    call: Call,
    cache: 'hit' | 'join' | undefined,
    unknownSpend: boolean,
    answer?: unknown,
  ): MaybePromise<void>;
  /**
   * Ends a stream's call when `finalResult` settles. Observed on the side and never replaced, so
   * the caller sees the same promise.
   */
  observeStream(
    call: Call,
    cache: 'hit' | 'join' | undefined,
    stream: { finalResult: PromiseLike<unknown> },
  ): void;
}

export interface CallFinisherDeps {
  guard: Guard;
  gate: BudgetGate;
  warnings: BudgetWarnings;
  registry: TotalsRegistry;
  savedSpend: SavedSpend;
  attribute: readonly string[];
}

export function createCallFinisher(deps: CallFinisherDeps): CallFinisher {
  const { guard, gate, warnings, registry, savedSpend, attribute } = deps;

  const finish: CallFinisher['finish'] = (call, cache, unknownSpend, answer) => {
    const { recorder, request, ctx, reservation } = call;

    guard(
      'commit',
      () => {
        const fields = recorder.commit();
        if (!fields) return;

        // A hit or join made no provider call: estimate what it spared, at the primary's price.
        const savedNanoUsd = cache ? savedSpend(request, answer, ctx) : undefined;
        ctx.state.set(usageStateKey, {
          ...fields,
          ...(savedNanoUsd === undefined ? {} : { estimatedSavedUsd: nanoToUsd(savedNanoUsd) }),
        });
        registry.add(
          {
            savedNanoUsd,
            snapshot: recorder.snapshot(),
            fallbackProvider: ctx.primaryProvider,
            fallbackModel: ctx.primaryModel,
            attribution: attributionOf(attribute, ctx.context),
            cache,
            unknownSpend,
          },
          Date.now(),
        );
      },
      undefined,
    );

    if (!reservation) return;

    // A call that reported no usage spent nothing known, so its whole hold is freed. All of this
    // stays synchronous when the store is, so a stream's warning is emitted before the logger's
    // `finalResult` observer builds its record.
    const { tableCharges, reportedCharges, unpricedCharges } = recorder.snapshot();
    const settled =
      tableCharges + reportedCharges + unpricedCharges === 0
        ? gate.release(reservation)
        : gate.settle(reservation, recorder.amount());
    return andThen(settled, () => warnings.check(reservation.scopes, ctx));
  };

  const observeStream: CallFinisher['observeStream'] = (call, cache, stream) => {
    void stream.finalResult.then(
      (answer) => finish(call, cache, false, answer),
      // An aborted stream's partial usage is never reported: its spend is unknown.
      (error: unknown) =>
        finish(call, cache, (error as { type?: string } | null)?.type === 'aborted'),
    );
  };

  return { finish, observeStream };
}
