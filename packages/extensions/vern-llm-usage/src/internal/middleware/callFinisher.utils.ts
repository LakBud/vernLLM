import { usageStateKey } from '../../logFields.js';
import { andThen, type MaybePromise } from '../maybePromise.utils.js';
import { nanoToUsd } from '../pricing/charge.utils.js';
import { attributionOf } from '../totals/attribution.utils.js';

import type { Amount } from '../../types/index.js';
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
   * Ends the call once: publishes its cost, adds it to the totals, settles the hold and warns.
   * Never throws.
   */
  finish(
    call: Call,
    cache: 'hit' | 'join' | undefined,
    unknownSpend: boolean,
    answer?: unknown,
  ): MaybePromise<void>;
  /** Ends a stream's call when `finalResult` settles, observed on the side. */
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

/** The larger of two amounts, per field. */
function atLeast(actual: Amount, floor: Amount): Amount {
  return {
    nanoUsd: Math.max(actual.nanoUsd, floor.nanoUsd),
    tokens: Math.max(actual.tokens, floor.tokens),
  };
}

export function createCallFinisher(deps: CallFinisherDeps): CallFinisher {
  const { guard, gate, warnings, registry, savedSpend, attribute } = deps;

  const finish: CallFinisher['finish'] = (call, cache, unknownSpend, answer) => {
    const { recorder, request, ctx, reservation } = call;
    if (recorder.done) return;

    guard(
      'commit',
      () => {
        // Not done yet, so this settles it.
        const fields = recorder.commit()!;

        // A hit or join made no provider call: estimate what it spared.
        const savedNanoUsd = cache ? savedSpend(request, answer, ctx) : undefined;
        const budgetShare = reservation?.shares.reduce<number | undefined>(
          (highest, entry) =>
            highest === undefined ? entry.share : Math.max(highest, entry.share),
          undefined,
        );
        ctx.state.set(usageStateKey, {
          ...fields,
          ...(budgetShare === undefined ? {} : { budgetShare }),
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

    // No usage frees the hold, but an aborted stream keeps it as spend. Synchronous with a
    // synchronous store, so a stream's warning lands before the logger's record.
    const { tableCharges, reportedCharges, unpricedCharges } = recorder.snapshot();
    const reported = tableCharges + reportedCharges + unpricedCharges > 0;
    const spent = unknownSpend ? atLeast(recorder.amount(), reservation.held) : recorder.amount();
    const settled =
      reported || unknownSpend ? gate.settle(reservation, spent) : gate.release(reservation);
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
