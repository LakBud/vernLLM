import { errorName } from '../errors.utils.js';
import { isThenable } from '../thenable.utils.js';
import { segmentKey, toSpans } from './spans.utils.js';

import type { AuditEffect, CheckError, CheckReport, Finding, Segment } from '../../types/index.js';
import type { CompiledCheck, CompiledChecks } from '../../types/resolvedConfig.js';
import type { CallCache, ScanDeps, ScanFinding, ScanResult, Span } from './types.js';

class DetectorTimeoutError extends Error {
  override name = 'DetectorTimeoutError';
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

interface Pending {
  check: CompiledCheck;
  controller: AbortController;
  /** Positions in `positions` still to be found by the detector. */
  todo: number[];
  positions: number[];
  spans: (readonly Span[])[];
  hits: number;
  texts: string[];
  started: number;
}

/**
 * Runs the checks that apply over the segments. Detectors that answer with an array finish
 * synchronously, and the whole scan is then synchronous too: a block among them means no
 * detector after it is started, so a cheap check saves a model call. Findings are remembered in
 * `cache` for this call and in the memo for the next, so text already scanned is a lookup.
 *
 * Nothing here reads or keeps text beyond the calls to the detectors.
 */
export function scan(
  compiled: CompiledChecks,
  segments: readonly Segment[],
  cache: CallCache,
  deps: ScanDeps,
): ScanResult | Promise<ScanResult> {
  const started = performance.now();
  const keys: (string | undefined)[] = [];
  const keyOf = (index: number): string => (keys[index] ??= segmentKey(segments[index]!));

  const reports = new Map<string, CheckReport>();
  const labelOf = new Map<string, string>();
  const audit = new Map<string, AuditEffect>();
  const errors: CheckError[] = [];
  const findings: ScanFinding[] = [];
  const slow: string[] = [];
  let fresh = 0;
  const running = new Set<AbortController>();
  let unknown = false;
  let blocked: ScanResult['blocked'];
  let settled = false;
  let outstanding = 0;
  let resolveScan: ((result: ScanResult) => void) | undefined;

  const abortRunning = (): void => {
    for (const controller of running) controller.abort();
    running.clear();
  };

  const record = (
    check: CompiledCheck,
    spans: readonly (readonly Span[])[],
    positions: readonly number[],
    todo: readonly number[],
    ms: number,
    hits: number,
  ): void => {
    let found = 0;
    let unredactable = 0;
    let freshFound = 0;
    const kinds = new Set<string>();
    const freshPositions = new Set(todo);
    const kept: ScanFinding[] = [];

    spans.forEach((list, position) => {
      const segment = positions[position]!;
      for (const span of list) {
        if (deps.skip?.(segment, span, check)) continue;
        found++;
        if (span.label !== undefined) kinds.add(span.label);
        if (span.start === undefined) unredactable++;
        if (freshPositions.has(position)) freshFound++;
        kept.push({ check, segment, span });
      }
    });

    const redacts = check.action === 'redact' && !check.audit;
    reports.set(check.id, {
      found,
      ...(kinds.size > 0 && { kinds: [...kinds] }),
      ms: round(ms),
      ...(hits > 0 && { memo: hits }),
      ...(redacts && unredactable > 0 && { unredactable }),
    });
    if (found === 0) return;

    if (check.audit) {
      audit.set(check.id, check.action);
      return;
    }
    findings.push(...kept);
    fresh += freshFound;
    labelOf.set(check.id, check.label);
    if (check.action === 'block' && blocked === undefined) {
      blocked = { check: check.id, label: check.label, failed: false };
    }
    // A value that cannot be located cannot be replaced, so the call is refused instead.
    if (redacts && unredactable > 0 && blocked === undefined) {
      blocked = { check: check.id, label: check.label, failed: false };
    }
  };

  const fail = (check: CompiledCheck, error: unknown): void => {
    errors.push({ check: check.id, name: errorName(error) });
    // An audit check changes nothing, and a check set to open is skipped.
    if (check.audit || !check.failClosed) return;

    // A redaction that cannot be guaranteed is as bad as a block that cannot be checked.
    if (check.action === 'label') unknown = true;
    else blocked ??= { check: check.id, failed: true };
  };

  /** Stores what the detector found, so the same text is a lookup next time. */
  const remember = (pending: Pending, found: unknown): void => {
    const grouped = toSpans(found, pending.texts);
    pending.todo.forEach((position, index) => {
      const spans = grouped[index]!;
      pending.spans[position] = spans;
      const key = `${pending.check.id}\u0000${keyOf(pending.positions[position]!)}`;
      cache.set(key, spans);
      deps.memo?.set(`${compiled.version}\u0000${key}`, spans);
    });
  };

  const finalize = (): ScanResult => {
    settled = true;
    abortRunning();

    const labels: string[] = [];
    const checks: [string, CheckReport][] = [];
    for (const check of compiled.checks) {
      const label = labelOf.get(check.id);
      if (label !== undefined && !labels.includes(label)) labels.push(label);
      const report = reports.get(check.id);
      if (report !== undefined) checks.push([check.id, report]);
    }

    return {
      labels,
      unknown,
      ...(blocked !== undefined && { blocked }),
      findings,
      fresh,
      slow,
      report: {
        checks: Object.fromEntries(checks),
        audit: Object.fromEntries(audit),
        errors,
        late: 0,
        unscanned: 0,
      },
      ms: round(performance.now() - started),
    };
  };

  /** Whether the check's `when` lets it run. A `when` that throws is a failure of the check. */
  const appliesTo = (check: CompiledCheck): boolean | 'failed' => {
    if (check.when === undefined) return true;
    try {
      return Boolean(check.when(deps.ctx));
    } catch (error) {
      fail(check, error);
      return 'failed';
    }
  };

  /** What this call or an earlier one already found for a segment, if anything. */
  const lookup = (key: string): readonly Span[] | undefined => {
    const known = cache.get(key);
    if (known !== undefined || deps.memo === undefined) return known;
    const remembered = deps.memo.get(`${compiled.version}\u0000${key}`);
    if (remembered !== undefined) cache.set(key, remembered);
    return remembered;
  };

  const settleIfDone = (): void => {
    if (settled || (blocked === undefined && outstanding > 0)) return;
    resolveScan?.(finalize());
  };

  for (const check of compiled.checks) {
    if (blocked !== undefined) break;
    if (deps.only !== undefined && !deps.only.has(check.id)) continue;

    // Skipped by its own `when` counts as ran, and found nothing.
    const applies = appliesTo(check);
    if (applies === 'failed') continue;
    if (!applies) continue;

    const positions: number[] = [];
    for (let index = 0; index < segments.length; index++) {
      if (check.sources.has(segments[index]!.source)) positions.push(index);
    }
    if (positions.length === 0) continue;

    const spans: (readonly Span[])[] = [];
    const todo: number[] = [];
    let hits = 0;
    positions.forEach((segmentIndex, position) => {
      const key = `${check.id}\u0000${keyOf(segmentIndex)}`;
      const known = lookup(key);
      if (known === undefined) todo.push(position);
      else {
        spans[position] = known;
        hits++;
      }
    });

    if (todo.length === 0) {
      record(check, spans, positions, todo, 0, hits);
      continue;
    }

    const texts = todo.map((position) => segments[positions[position]!]!.text);
    const batch = todo.map((position) => segments[positions[position]!]!);
    const pending: Pending = {
      check,
      controller: new AbortController(),
      todo,
      positions,
      spans,
      hits,
      texts,
      started: performance.now(),
    };
    const signal =
      deps.signal === undefined
        ? pending.controller.signal
        : AbortSignal.any([deps.signal, pending.controller.signal]);

    let answer: Finding[] | PromiseLike<Finding[]>;
    try {
      answer = check.detect(batch, signal);
    } catch (error) {
      fail(check, error);
      continue;
    }

    if (!isThenable(answer)) {
      try {
        remember(pending, answer);
      } catch (error) {
        fail(check, error);
        continue;
      }
      record(check, spans, positions, todo, performance.now() - pending.started, hits);
      continue;
    }

    // A slow detector. It is raced against its timeout, which never runs past the call's deadline.
    slow.push(check.id);
    const thenable = answer;
    const budget = Math.min(
      check.timeoutMs,
      Math.max(0, (deps.deadlineAt ?? Infinity) - Date.now()),
    );
    const answered = new Promise<Finding[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.controller.abort();
        reject(new DetectorTimeoutError('a detector did not answer in time'));
      }, budget);
      timer.unref();
      thenable.then(
        (found) => {
          clearTimeout(timer);
          resolve(found);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

    outstanding++;
    running.add(pending.controller);
    answered.then(
      (found) => {
        running.delete(pending.controller);
        outstanding--;
        try {
          // Remembered even when the scan is already over: the answer is as good as any.
          remember(pending, found);
          if (!settled) {
            record(
              check,
              pending.spans,
              positions,
              todo,
              performance.now() - pending.started,
              hits,
            );
          }
        } catch (error) {
          if (!settled) fail(check, error);
        }
        settleIfDone();
      },
      (error: unknown) => {
        running.delete(pending.controller);
        outstanding--;
        if (!settled) fail(check, error);
        settleIfDone();
      },
    );
  }

  if (blocked !== undefined || outstanding === 0) return finalize();

  return new Promise<ScanResult>((resolve) => {
    resolveScan = resolve;
  });
}
