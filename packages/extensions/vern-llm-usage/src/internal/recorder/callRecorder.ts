import { nanoToUsd } from '../pricing/charge.utils.js';

import type { Amount, CostSource } from '../../types/index.js';

/** What one finished call cost, in the public USD form. */
export interface CallSummary {
  /** Everything the call spent, wasted attempts included. */
  estimatedCostUsd: number;
  /** The part spent on attempts whose response was then rejected. */
  wastedUsd: number;
  /** Absent when the call reported no usage at all, such as a cache hit. */
  costSource?: CostSource;
}

/** The token kinds of one report, as the provider gave them. */
export interface TokenKinds {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** What `charge` is told besides the money, for totals. */
export interface ChargeDetail {
  provider?: string;
  model: string;
  kinds: TokenKinds;
  /** The money came from the provider's response, not from the price table. */
  reported?: boolean;
}

/** What a finished call adds to the totals, in integer nano dollars. */
export interface CallSnapshot {
  nanoUsd: number;
  wastedNanoUsd: number;
  tokens: TokenKinds;
  tableCharges: number;
  reportedCharges: number;
  unpricedCharges: number;
  /** Who produced the last charge. Absent for a call that was never charged. */
  provider?: string;
  model?: string;
}

/**
 * The charges for one logical call. Money stays in integer nano dollars until `commit`. A call can
 * hold several charges: one per attempt that reported usage, wasted or not.
 */
export class CallRecorder {
  private total = 0;
  private wasted = 0;
  private tokens = 0;
  private charges = 0;
  private anyUnpriced = false;
  private unpricedCharges = 0;
  private reportedCharges = 0;
  private readonly kinds: TokenKinds = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  private last: { provider?: string; model: string } | undefined;
  private ended = false;

  /**
   * `nanoUsd` is `undefined` when usage was reported for a model with no price: the tokens still
   * count, but the money is unknown and left out.
   */
  charge(
    nanoUsd: number | undefined,
    wasted: boolean,
    tokens: number,
    detail?: ChargeDetail,
  ): void {
    if (this.ended) return;

    this.charges++;
    this.tokens += tokens;
    if (detail?.reported) this.reportedCharges++;
    if (detail) {
      this.last = { provider: detail.provider, model: detail.model };
      for (const kind of Object.keys(this.kinds) as (keyof TokenKinds)[]) {
        this.kinds[kind] += detail.kinds[kind];
      }
    }
    if (nanoUsd === undefined) {
      this.anyUnpriced = true;
      this.unpricedCharges++;
      return;
    }

    this.total += nanoUsd;
    if (wasted) this.wasted += nanoUsd;
  }

  /** What the call adds to the totals. Valid before and after `commit`. */
  snapshot(): CallSnapshot {
    return {
      nanoUsd: this.total,
      wastedNanoUsd: this.wasted,
      tokens: { ...this.kinds },
      tableCharges: this.charges - this.unpricedCharges - this.reportedCharges,
      reportedCharges: this.reportedCharges,
      unpricedCharges: this.unpricedCharges,
      provider: this.last?.provider,
      model: this.last?.model,
    };
  }

  /** What the call really spent, as integers, for a store to settle against. */
  amount(): Amount {
    return { nanoUsd: this.total, tokens: this.tokens };
  }

  /**
   * The only exit: settles the call once. Later charges are dropped. A call with any unpriced
   * charge is `'unpriced'` as a whole, since its cost is then a lower bound, and otherwise it is
   * `'table'` if any charge was priced from the table, else `'reported'`.
   */
  commit(): CallSummary | undefined {
    if (this.ended) return undefined;
    this.ended = true;

    const summary: CallSummary = {
      estimatedCostUsd: nanoToUsd(this.total),
      wastedUsd: nanoToUsd(this.wasted),
    };
    if (this.charges > 0) {
      const tableCharges = this.charges - this.unpricedCharges - this.reportedCharges;
      summary.costSource = this.anyUnpriced ? 'unpriced' : tableCharges > 0 ? 'table' : 'reported';
    }
    return summary;
  }
}
