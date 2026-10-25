import { errorName } from '../errors.utils.js';
import { isThenable } from '../thenable.utils.js';
import { segmentKey, toSpans } from './spans.utils.js';
import { tally } from './tally.utils.js';
import { budgetFor, withTimeout } from './timeout.utils.js';

import type { AuditEffect, CheckError, CheckReport, Finding, Segment } from '../../types/index.js';
import type { CompiledCheck, CompiledChecks } from '../../types/resolvedConfig.js';
import type { CallCache, ScanDeps, ScanFinding, ScanResult, Span } from './types.js';

const round = (ms: number): number => Math.round(ms * 100) / 100;

/** One check on its way through the scan: what is known of its segments, and what is still to ask. */
interface Pending {
  check: CompiledCheck;
  /** Segment indexes this check applies to. */
  positions: number[];
  /** What is known, by position in `positions`. */
  spans: (readonly Span[])[];
  /** Positions in `positions` the detector still has to read. */
  todo: number[];
  /** How many positions were answered from the call's cache or the memo. */
  hits: number;
  started: number;
}

/**
 * One scan: the checks that apply, run over the segments in order. Detectors that answer with an
 * array finish synchronously, and the whole scan is then synchronous too: a block among them means
 * no detector after it is started, so a cheap check saves a model call.
 */
export class ScanRun {
  private readonly started = performance.now();
  private readonly keys: (string | undefined)[] = [];

  private readonly reports = new Map<string, CheckReport>();
  private readonly labelOf = new Map<string, string>();
  private readonly audit = new Map<string, AuditEffect>();
  private readonly errors: CheckError[] = [];
  private readonly findings: ScanFinding[] = [];
  private readonly slow: string[] = [];
  private fresh = 0;
  private unknown = false;
  private blocked: ScanResult['blocked'];

  /** Detectors still running, so a block or the end of the scan can abort them. */
  private readonly running = new Set<AbortController>();
  private outstanding = 0;
  private settled = false;
  private resolveScan: ((result: ScanResult) => void) | undefined;

  constructor(
    private readonly compiled: CompiledChecks,
    private readonly segments: readonly Segment[],
    private readonly cache: CallCache,
    private readonly deps: ScanDeps,
  ) {}

  run(): ScanResult | Promise<ScanResult> {
    for (const check of this.compiled.checks) {
      if (this.blocked !== undefined) break;
      if (this.isLeftOut(check)) continue;
      this.runCheck(check);
    }

    if (this.blocked !== undefined || this.outstanding === 0) return this.finalize();

    return new Promise<ScanResult>((resolve) => {
      this.resolveScan = resolve;
    });
  }

  // Which checks run, and over what

  /** Whether the check is not asked: not wanted by the caller, or its own `when` says no. */
  private isLeftOut(check: CompiledCheck): boolean {
    if (this.deps.only !== undefined && !this.deps.only.has(check.id)) return true;
    if (check.when === undefined) return false;

    // Skipped by its own `when` counts as ran, and found nothing.
    try {
      return !check.when(this.deps.ctx);
    } catch (error) {
      this.fail(check, error);
      return true;
    }
  }

  private keyOf(index: number): string {
    return (this.keys[index] ??= segmentKey(this.segments[index]!));
  }

  private cacheKey(check: CompiledCheck, segmentIndex: number): string {
    return `${check.id}\u0000${this.keyOf(segmentIndex)}`;
  }

  /** What this call or an earlier one already found for a segment, if anything. */
  private lookup(key: string): readonly Span[] | undefined {
    const known = this.cache.get(key);
    const { memo } = this.deps;
    if (known !== undefined || memo === undefined) return known;

    const remembered = memo.get(`${this.compiled.version}\u0000${key}`);
    if (remembered !== undefined) this.cache.set(key, remembered);
    return remembered;
  }

  /** Splits the segments a check applies to into those already known and those to ask about. */
  private plan(check: CompiledCheck): Pending | undefined {
    const positions: number[] = [];
    this.segments.forEach((segment, index) => {
      if (check.sources.has(segment.source)) positions.push(index);
    });
    if (positions.length === 0) return undefined;

    const pending: Pending = {
      check,
      positions,
      spans: [],
      todo: [],
      hits: 0,
      started: performance.now(),
    };
    positions.forEach((segmentIndex, position) => {
      const known = this.lookup(this.cacheKey(check, segmentIndex));
      if (known === undefined) {
        pending.todo.push(position);
      } else {
        pending.spans[position] = known;
        pending.hits++;
      }
    });
    return pending;
  }

  // Running one check

  private runCheck(check: CompiledCheck): void {
    const pending = this.plan(check);
    if (pending === undefined) return;

    if (pending.todo.length === 0) {
      this.record(pending, 0);
      return;
    }
    this.detect(pending);
  }

  private batchOf(pending: Pending): Segment[] {
    return pending.todo.map((position) => this.segments[pending.positions[position]!]!);
  }

  /** Asks the detector, and settles the check now or when its promise does. */
  private detect(pending: Pending): void {
    const { check } = pending;
    const controller = new AbortController();
    const signal =
      this.deps.signal === undefined
        ? controller.signal
        : AbortSignal.any([this.deps.signal, controller.signal]);

    let answer: Finding[] | PromiseLike<Finding[]>;
    try {
      answer = check.detect(this.batchOf(pending), signal);
    } catch (error) {
      this.fail(check, error);
      return;
    }

    if (isThenable(answer)) {
      this.watch(pending, answer, controller);
      return;
    }
    try {
      this.remember(pending, answer);
    } catch (error) {
      this.fail(check, error);
      return;
    }
    this.record(pending, performance.now() - pending.started);
  }

  /** A slow detector. It is raced against its timeout, which never runs past the call's deadline. */
  private watch(
    pending: Pending,
    answer: PromiseLike<Finding[]>,
    controller: AbortController,
  ): void {
    const { check } = pending;
    this.slow.push(check.id);
    this.outstanding++;
    this.running.add(controller);

    const budget = budgetFor(check.timeoutMs, this.deps.deadlineAt);
    withTimeout(answer, budget, controller).then(
      (found) => {
        this.finished(controller);
        this.accept(pending, found);
        this.settleIfDone();
      },
      (error: unknown) => {
        this.finished(controller);
        if (!this.settled) this.fail(check, error);
        this.settleIfDone();
      },
    );
  }

  private finished(controller: AbortController): void {
    this.running.delete(controller);
    this.outstanding--;
  }

  /** A slow detector's answer: remembered even when the scan is over, recorded only if it is not. */
  private accept(pending: Pending, found: Finding[]): void {
    try {
      this.remember(pending, found);
      if (!this.settled) this.record(pending, performance.now() - pending.started);
    } catch (error) {
      if (!this.settled) this.fail(pending.check, error);
    }
  }

  // What a check's answer does

  /** Stores what the detector found, so the same text is a lookup next time. */
  private remember(pending: Pending, found: unknown): void {
    const texts = this.batchOf(pending).map((segment) => segment.text);
    const grouped = toSpans(found, texts);

    pending.todo.forEach((position, index) => {
      const spans = grouped[index]!;
      pending.spans[position] = spans;
      const key = this.cacheKey(pending.check, pending.positions[position]!);
      this.cache.set(key, spans);
      if (!this.deps.memoReadOnly) {
        this.deps.memo?.set(`${this.compiled.version}\u0000${key}`, spans);
      }
    });
  }

  private block(check: CompiledCheck): void {
    this.blocked ??= { check: check.id, label: check.label, failed: false };
  }

  /** Counts what a check found, and decides what that does to the call. */
  private record(pending: Pending, ms: number): void {
    const { check } = pending;
    const { found, kinds, unredactable, freshFound, kept } = tally(
      check,
      pending.spans,
      pending.positions,
      pending.todo,
      this.deps.skip,
    );

    const redacts = check.action === 'redact' && !check.audit;
    this.reports.set(check.id, {
      found,
      ...(kinds.size > 0 && { kinds: [...kinds] }),
      ms: round(ms),
      ...(pending.hits > 0 && { memo: pending.hits }),
      ...(redacts && unredactable > 0 && { unredactable }),
    });
    if (found === 0) return;

    if (check.audit) {
      this.audit.set(check.id, check.action);
      return;
    }
    this.findings.push(...kept);
    this.fresh += freshFound;
    this.labelOf.set(check.id, check.label);

    // A value that cannot be located cannot be replaced, so the call is refused instead.
    if (check.action === 'block' || (redacts && unredactable > 0)) this.block(check);
  }

  private fail(check: CompiledCheck, error: unknown): void {
    this.errors.push({ check: check.id, name: errorName(error) });
    // An audit check changes nothing, and a check set to open is skipped.
    if (check.audit || !check.failClosed) return;

    // A redaction that cannot be guaranteed is as bad as a block that cannot be checked.
    if (check.action === 'label') this.unknown = true;
    else this.blocked ??= { check: check.id, failed: true };
  }

  private settleIfDone(): void {
    if (this.settled || (this.blocked === undefined && this.outstanding > 0)) return;
    this.resolveScan?.(this.finalize());
  }

  private finalize(): ScanResult {
    this.settled = true;
    for (const controller of this.running) controller.abort();
    this.running.clear();

    const labels: string[] = [];
    const checks: [string, CheckReport][] = [];
    for (const check of this.compiled.checks) {
      const label = this.labelOf.get(check.id);
      if (label !== undefined && !labels.includes(label)) labels.push(label);
      const report = this.reports.get(check.id);
      if (report !== undefined) checks.push([check.id, report]);
    }

    return {
      labels,
      unknown: this.unknown,
      ...(this.blocked !== undefined && { blocked: this.blocked }),
      findings: this.findings,
      fresh: this.fresh,
      slow: this.slow,
      report: {
        checks: Object.fromEntries(checks),
        audit: Object.fromEntries(this.audit),
        errors: this.errors,
        late: 0,
        unscanned: 0,
      },
      ms: round(performance.now() - this.started),
    };
  }
}
