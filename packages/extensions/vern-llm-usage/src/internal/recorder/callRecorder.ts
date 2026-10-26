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
  /** Absent unless a chain whose result was not returned spent something. */
  unkeptUsd?: number;
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
  /** The chain that made the request, absent for the main chain. */
  chain?: number;
}

/** The charges of one call that one provider and model produced, in integer nano dollars. */
export interface ChargePart {
  /** Absent for a charge that said who produced it. */
  provider?: string | undefined;
  model?: string | undefined;
  nanoUsd: number;
  wastedNanoUsd: number;
  /** The part spent by chains whose result was not returned. */
  unkeptNanoUsd: number;
  tokens: TokenKinds;
  tableCharges: number;
  reportedCharges: number;
  unpricedCharges: number;
}

/** What a finished call adds to the totals, in integer nano dollars. */
export interface CallSnapshot {
  nanoUsd: number;
  wastedNanoUsd: number;
  unkeptNanoUsd: number;
  tokens: TokenKinds;
  tableCharges: number;
  reportedCharges: number;
  unpricedCharges: number;
  /** Who produced the last charge, who answered. Absent for a call that was never charged. */
  provider?: string;
  model?: string;
  /**
   * The same charges split by who produced them, so a fallback's spend and the primary's wasted
   * attempt land on their own targets.
   */
  parts: ChargePart[];
}

interface PartTally extends Omit<ChargePart, 'tableCharges' | 'unkeptNanoUsd'> {
  charges: number;
}

/** One priced charge, kept so the spend of chains that were not returned can be split out. */
interface PricedCharge {
  partKey: string;
  chain: number;
  nanoUsd: number;
}

const partKeyOf = (detail: ChargeDetail | undefined): string =>
  JSON.stringify([detail?.provider ?? null, detail?.model ?? null]);

const emptyKinds = (): TokenKinds => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});

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
  private readonly kinds: TokenKinds = emptyKinds();
  private last: { provider?: string; model: string } | undefined;
  private readonly parts = new Map<string, PartTally>();
  private readonly priced: PricedCharge[] = [];
  private kept = 0;
  private ended = false;

  /** Whether `commit` has settled the call, after which nothing more is recorded. */
  get done(): boolean {
    return this.ended;
  }

  /** Which chain's result the call returned. The main chain unless told otherwise. */
  keep(chain: number): void {
    this.kept = chain;
  }

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
    const part = this.partFor(detail);
    part.charges++;
    if (detail?.reported) {
      this.reportedCharges++;
      part.reportedCharges++;
    }
    if (detail) {
      this.last = { provider: detail.provider, model: detail.model };
      for (const kind of Object.keys(this.kinds) as (keyof TokenKinds)[]) {
        this.kinds[kind] += detail.kinds[kind];
        part.tokens[kind] += detail.kinds[kind];
      }
    }
    if (nanoUsd === undefined) {
      this.anyUnpriced = true;
      this.unpricedCharges++;
      part.unpricedCharges++;
      return;
    }

    this.total += nanoUsd;
    part.nanoUsd += nanoUsd;
    this.priced.push({ partKey: partKeyOf(detail), chain: detail?.chain ?? 0, nanoUsd });
    if (wasted) {
      this.wasted += nanoUsd;
      part.wastedNanoUsd += nanoUsd;
    }
  }

  private partFor(detail: ChargeDetail | undefined): PartTally {
    const key = partKeyOf(detail);
    let part = this.parts.get(key);
    if (!part) {
      part = {
        provider: detail?.provider,
        model: detail?.model,
        nanoUsd: 0,
        wastedNanoUsd: 0,
        tokens: emptyKinds(),
        charges: 0,
        reportedCharges: 0,
        unpricedCharges: 0,
      };
      this.parts.set(key, part);
    }
    return part;
  }

  /** What the call adds to the totals. Valid before and after `commit`. */
  snapshot(): CallSnapshot {
    const unkept = new Map<string, number>();
    let unkeptTotal = 0;
    for (const charge of this.priced) {
      if (charge.chain === this.kept) continue;
      unkeptTotal += charge.nanoUsd;
      unkept.set(charge.partKey, (unkept.get(charge.partKey) ?? 0) + charge.nanoUsd);
    }

    return {
      nanoUsd: this.total,
      wastedNanoUsd: this.wasted,
      unkeptNanoUsd: unkeptTotal,
      tokens: { ...this.kinds },
      tableCharges: this.charges - this.unpricedCharges - this.reportedCharges,
      reportedCharges: this.reportedCharges,
      unpricedCharges: this.unpricedCharges,
      provider: this.last?.provider,
      model: this.last?.model,
      parts: [...this.parts.entries()].map(([key, { charges, ...part }]) => ({
        ...part,
        unkeptNanoUsd: unkept.get(key) ?? 0,
        tokens: { ...part.tokens },
        tableCharges: charges - part.unpricedCharges - part.reportedCharges,
      })),
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
    const { unkeptNanoUsd } = this.snapshot();
    if (unkeptNanoUsd > 0) summary.unkeptUsd = nanoToUsd(unkeptNanoUsd);
    if (this.charges > 0) {
      const tableCharges = this.charges - this.unpricedCharges - this.reportedCharges;
      summary.costSource = this.anyUnpriced ? 'unpriced' : tableCharges > 0 ? 'table' : 'reported';
    }
    return summary;
  }
}
