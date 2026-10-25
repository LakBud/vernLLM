import { LLMError } from '../../../../types/errors.js';
import { chainSignal } from '../../../utils/chain.utils.js';
import { recordChainStart } from './middleware.utils.js';

import type { CallParams, CallResult, MiddlewareStateBag } from '../../../../types/index.js';

/** At most this many chains started with `next.again()` per call, counted across nested layers. */
export const MAX_RERUNS_PER_CALL = 4;

/** One chain of the layers inside a `wrap`: the main chain (0) or a rerun (1 and up). */
export interface Chain {
  number: number;
  /** The params this chain runs with: the call's, or a copy with this chain's signal. */
  params: CallParams<unknown>;
}

type Run = (chain: Chain) => Promise<CallResult>;

/** The chain a `keep` matched: its number, and the result it produced itself. */
export interface KeptChain {
  number: number;
  result: CallResult;
}

interface Entry {
  number: number;
  controller: AbortController;
  result?: CallResult;
}

/** One `reruns: true` layer's chains: start, limit, keep one, cancel the rest. */
export class ChainSet {
  private readonly entries: Entry[] = [];
  /** Results in the order they resolved, for a `wrap` that throws after one did. */
  private readonly resolved: CallResult[] = [];

  constructor(
    private readonly incoming: Chain,
    /** Shared by every layer of the call. */
    private readonly reruns: { count: number },
    /** This layer's position in the `wrap` nesting. */
    private readonly layer: number,
    private readonly state: MiddlewareStateBag,
  ) {}

  /** The main chain: same number and `meta` as the incoming chain, but cancellable. */
  main(run: Run): Promise<CallResult> {
    return this.start(this.incoming.number, true, run);
  }

  get canRerun(): boolean {
    return this.reruns.count < MAX_RERUNS_PER_CALL;
  }

  /** A new chain. Its params drop `meta`, so it never writes the caller's while running. */
  rerun(run: Run): Promise<CallResult> {
    if (!this.canRerun) {
      return Promise.reject(
        new LLMError(
          `At most ${MAX_RERUNS_PER_CALL} chains can run again per call`,
          'invalid_params',
        ),
      );
    }

    this.reruns.count++;
    recordChainStart(this.state, this.reruns.count, {
      parent: this.incoming.number,
      layer: this.layer,
    });

    return this.start(this.reruns.count, false, run);
  }

  get startedAny(): boolean {
    return this.entries.length > 0;
  }

  firstResolved(): CallResult | undefined {
    return this.resolved[0];
  }

  /**
   * Cancels every chain whose result isn't `kept`, pending ones included, and returns the kept
   * chain's number and own result. `kept` undefined cancels them all.
   */
  keep(kept: CallResult | undefined): KeptChain | undefined {
    // The result itself first, then any chain whose value it returned: a `wrap` may rebuild the
    // `CallResult` around a chain's value. Only one chain is kept, even when values are equal.
    const keptEntry =
      kept === undefined
        ? undefined
        : (this.entries.find((entry) => entry.result === kept) ??
          this.entries.find(
            (entry) => entry.result !== undefined && entry.result.value === kept.value,
          ));

    for (const entry of this.entries) {
      if (entry !== keptEntry) entry.controller.abort();
    }

    return keptEntry?.result ? { number: keptEntry.number, result: keptEntry.result } : undefined;
  }

  private start(number: number, keepMeta: boolean, run: Run): Promise<CallResult> {
    const controller = new AbortController();
    const entry: Entry = { number, controller };
    const params = this.incoming.params;

    this.entries.push(entry);

    // A `run` that throws before returning a promise still rejects, never throws from here.
    let promise: Promise<CallResult>;

    try {
      promise = run({
        number,
        params: {
          ...params,
          signal: chainSignal(params.signal, controller.signal, number),
          ...(keepMeta ? {} : { meta: undefined }),
        },
      });
    } catch (error) {
      promise = Promise.reject(error);
    }

    // Records the result, and keeps a chain nobody awaits from rejecting unhandled.
    promise.then(
      (result) => {
        entry.result = result;
        this.resolved.push(result);
      },
      () => {},
    );

    return promise;
  }
}
