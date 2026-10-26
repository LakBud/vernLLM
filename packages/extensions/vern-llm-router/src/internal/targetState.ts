/** Most targets tracked at once. A chain has a handful; the cap only guards against odd event names. */
const MAX_TARGETS = 256;

/** How long a target cools down after a 429 that said nothing, and the longest it ever does. */
export const DEFAULT_COOLDOWN_MS = 5_000;
export const MAX_COOLDOWN_MS = 60_000;

/** How long a target is held back by an event rule that names no time. */
export const DEFAULT_HOLD_MS = 10_000;

/** The lowest share of traffic a target gets right after its breaker closes. */
const WARMING_FLOOR = 0.1;

interface Entry {
  inFlight: number;
  cooldownUntil: number;
  warmSince: number | undefined;
}

export interface TargetReading {
  inFlight: number;
  /** Whether a provider 429 still holds this target back. */
  cooling: boolean;
  /** `1`, or `0.1` to `1` while ramping up after the breaker closed. */
  warmingFactor: number;
}

/**
 * What the router counts itself: attempts in flight, 429 cooldowns and warming per target name.
 * One capped map, and an entry with nothing to remember is dropped.
 */
export class TargetState {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly slowStartMs: number) {}

  private entry(name: string): Entry | undefined {
    const found = this.entries.get(name);
    if (found) return found;
    if (this.entries.size >= MAX_TARGETS) return undefined;

    const created: Entry = { inFlight: 0, cooldownUntil: 0, warmSince: undefined };
    this.entries.set(name, created);
    return created;
  }

  private prune(name: string, entry: Entry, now: number): void {
    if (entry.inFlight === 0 && entry.cooldownUntil <= now && entry.warmSince === undefined) {
      this.entries.delete(name);
    }
  }

  attemptStarted(name: string): void {
    const entry = this.entry(name);
    if (entry) entry.inFlight += 1;
  }

  attemptEnded(name: string, now: number): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    this.prune(name, entry, now);
  }

  /** A provider 429: hold the target back for `Retry-After`, or 5 s without one, at most 60 s. */
  rateLimited(name: string, retryAfterMs: number | undefined, now: number): void {
    const entry = this.entry(name);
    if (!entry) return;
    const wait =
      retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + Math.min(wait, MAX_COOLDOWN_MS));
  }

  /** A middleware reported the target as degraded: hold it back like a cooldown for `ms`. */
  holdBack(name: string, ms: number, now: number): void {
    const entry = this.entry(name);
    if (!entry) return;
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + Math.min(ms, MAX_COOLDOWN_MS));
  }

  /** The breaker closed after being open: start ramping the target back up. */
  recovered(name: string, now: number): void {
    if (this.slowStartMs <= 0) return;
    const entry = this.entry(name);
    if (entry) entry.warmSince = now;
  }

  read(name: string, now: number): TargetReading {
    const entry = this.entries.get(name);
    if (!entry) return { inFlight: 0, cooling: false, warmingFactor: 1 };

    let warmingFactor = 1;
    if (entry.warmSince !== undefined) {
      const elapsed = now - entry.warmSince;
      if (elapsed >= this.slowStartMs || elapsed < 0) {
        entry.warmSince = undefined;
        this.prune(name, entry, now);
      } else {
        warmingFactor = WARMING_FLOOR + (1 - WARMING_FLOOR) * (elapsed / this.slowStartMs);
      }
    }
    return { inFlight: entry.inFlight, cooling: entry.cooldownUntil > now, warmingFactor };
  }

  get size(): number {
    return this.entries.size;
  }
}
