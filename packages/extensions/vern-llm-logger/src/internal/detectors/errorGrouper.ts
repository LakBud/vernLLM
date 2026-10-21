import { nowMs } from '../clock.utils.js';

import type { CallLogRecord, ErrorGroupEntry } from '../../types/index.js';

const MAX_FINGERPRINTS = 500;

interface Group {
  provider: string;
  type: string;
  code: string | undefined;
  startedAtMs: number;
  /** Errors after the first, which was let through on its own. */
  suppressed: number;
  firstRequestId: string;
  lastRequestId: string;
}

/** Collapses a burst of one failure into its first record plus one `error_group`. */
export class ErrorGrouper {
  private readonly groups = new Map<string, Group>();
  /** Closed windows found by `offer`, waiting for the next flush. */
  private readonly pending: ErrorGroupEntry[] = [];
  private closed = false;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = nowMs,
  ) {}

  /** `true` when the record is written on its own, `false` when it was counted. */
  offer(record: Readonly<CallLogRecord>): boolean {
    if (!record.error || this.closed) return true;

    const now = this.now();
    const provider = record.provider ?? record.path[record.path.length - 1]?.provider ?? 'unknown';
    const { type, code } = record.error;
    const key = JSON.stringify([provider, type, code ?? null]);

    const group = this.groups.get(key);
    if (group && now - group.startedAtMs < this.windowMs) {
      group.suppressed++;
      group.lastRequestId = record.requestId;
      return false;
    }

    // A window that has closed is reported before the next one starts under the same key.
    if (group) this.pending.push(...this.entryOf(group));
    if (!group && this.groups.size >= MAX_FINGERPRINTS) return true;

    this.groups.set(key, {
      provider,
      type,
      code,
      startedAtMs: now,
      suppressed: 0,
      firstRequestId: record.requestId,
      lastRequestId: record.requestId,
    });
    return true;
  }

  /** Entries for windows that have closed, or for every window when `force` is set. */
  flush(force = false): ErrorGroupEntry[] {
    const now = this.now();
    const entries = this.pending.splice(0);

    for (const [key, group] of this.groups) {
      if (!force && now - group.startedAtMs < this.windowMs) continue;
      entries.push(...this.entryOf(group));
      this.groups.delete(key);
    }
    return entries;
  }

  /** After this every error passes on its own: nothing is left to flush a suppressed one. */
  close(): void {
    this.closed = true;
  }

  clear(): void {
    this.groups.clear();
    this.pending.length = 0;
  }

  private entryOf(group: Group): ErrorGroupEntry[] {
    if (group.suppressed === 0) return [];

    const entry: ErrorGroupEntry = {
      kind: 'error_group',
      v: 1,
      provider: group.provider,
      type: group.type,
      count: group.suppressed + 1,
      windowMs: this.windowMs,
      firstRequestId: group.firstRequestId,
      lastRequestId: group.lastRequestId,
    };
    if (group.code !== undefined) entry.code = group.code;
    return [entry];
  }
}
