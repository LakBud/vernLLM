/** Absorbs the float error of adding `ratio` many times, so 20 calls at 0.05 make one token. */
const EPSILON = 1e-9;

/**
 * A token bucket that eligible calls refill and hedges drain. It starts empty, so hedging never
 * exceeds about `ratio` of calls, even when every call is slow, and a cold start never hedges.
 */
export class HedgeBudget {
  private tokens = 0;

  constructor(
    private readonly ratio: number,
    private readonly burst: number,
  ) {}

  /** One eligible call: adds `ratio` tokens, up to `burst`. */
  add(): void {
    this.tokens = Math.min(this.burst, this.tokens + this.ratio);
  }

  /** Gives back a token that was taken for a hedge that could not be sent. */
  refund(): void {
    this.tokens = Math.min(this.burst, this.tokens + 1);
  }

  /** Takes one token if there is one. */
  take(): boolean {
    if (this.tokens < 1 - EPSILON) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }
}
