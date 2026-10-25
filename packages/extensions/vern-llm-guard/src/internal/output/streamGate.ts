import { contentBlocked } from '../contentBlocked.utils.js';
import { errorName } from '../errors.utils.js';
import { scan } from '../scan/scan.js';
import { tokenRanges } from '../tokens/tokens.js';
import { gateOutput } from './gate.js';
import { emptyReport, unique } from './streamText.utils.js';
import { TextWindow, type StreamCounts } from './streamWindow.js';
import { mergeDelta, toolChunk, type OpenCall } from './toolCalls.utils.js';

import type { AuditEffect, CheckError, OutputReport } from '../../types/index.js';
import type { ScanResult, Span } from '../scan/types.js';
import type { SpanReplacement } from '../segments/types.js';
import type { StreamGateInput } from './types.js';
import type { StreamChunk } from 'vern-llm';

type Blocked = ScanResult['blocked'];
type ToolDelta = Extract<StreamChunk, { type: 'tool_call_delta' }>;
type Inspected = { pieces: SpanReplacement[] } | { error: Error };

/** The error for a scan that refused the answer; no `blocked` means the guard itself failed. */
function refusalOf(version: string, blocked: Blocked | undefined): Error {
  return contentBlocked(
    version,
    'output',
    blocked?.check,
    blocked?.label === undefined ? [] : [blocked.label],
    blocked?.failed ?? true,
  );
}

/** The replacements `redact` checks ask for, each with the check that asked. */
function redactionsOf(
  findings: ScanResult['findings'],
  mask: (label: string) => string,
): { id: string; piece: SpanReplacement }[] {
  return findings
    .filter(({ check }) => check.action === 'redact')
    .map(({ check, span }) => ({
      id: check.id,
      piece: { start: span.start!, end: span.end!, text: mask(span.label ?? check.label) },
    }));
}

/** A step either gives its result or the error that ends the stream. */
function unwrap<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}

class StreamGate {
  private readonly window: TextWindow;
  private readonly counts: StreamCounts = { masked: 0, late: 0 };

  /** Checks whose detector answered with a promise: they run once per window from then on. */
  private readonly slow = new Set<string>();
  private first = true;
  private ms = 0;
  private readonly errors: CheckError[] = [];
  private readonly audit: Record<string, AuditEffect> = {};
  private lastReport = emptyReport();

  /** The guard failed open: nothing more is checked. */
  private off = false;
  private settled = false;
  /** Refused already, so `finalResult` has nothing more to do. */
  private closed = false;
  private rejectFailure!: (error: unknown) => void;
  private readonly failure: Promise<never>;

  private readonly calls = new Map<number, OpenCall>();

  constructor(private readonly input: StreamGateInput) {
    const { compiled } = input;
    this.window = new TextWindow(
      {
        holdChars: compiled.stream.holdChars,
        release: compiled.stream.release,
        json: input.json,
        marker: input.marker,
        tokens: input.tokens,
      },
      this.counts,
    );
    this.failure = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    this.failure.catch(() => {});
  }

  start(): { chunks: AsyncIterable<StreamChunk>; finalResult: Promise<unknown> } {
    const finalResult = Promise.race([
      this.input.source.finalResult.then(
        (value) => this.onFinal(value),
        (error: unknown) => {
          // The provider failed, or the caller left: the call still gets its one result.
          this.settle(false);
          throw error;
        },
      ),
      this.failure,
    ]);
    finalResult.catch(() => {});

    return { chunks: { [Symbol.asyncIterator]: () => this.chunks() }, finalResult };
  }

  // The one result, and how a stream ends

  private settle(blocked: boolean, report?: OutputReport): void {
    if (this.settled) return;
    this.settled = true;

    const base = report ?? this.lastReport;
    this.input.onDone({
      report: {
        ...base,
        audit: { ...base.audit, ...this.audit },
        errors: unique([...base.errors, ...this.errors]),
        late: base.late + this.counts.late,
      },
      masked: this.counts.masked,
      ms: this.ms,
      blocked,
    });
  }

  /** Ends the stream with a refusal that `chunks` throws and `finalResult` rejects with. */
  private refuse(blocked: Blocked | undefined): Error {
    this.closed = true;
    const error = refusalOf(this.input.compiled.version, blocked);
    this.settle(true);
    this.rejectFailure(error);
    return error;
  }

  /** The guard itself broke: a refusal when it fails closed, else the stream goes unchecked. */
  private guardFailed(error: unknown): Error | undefined {
    this.errors.push({ name: errorName(error) });
    if (this.input.compiled.failClosed) return this.refuse(undefined);
    this.off = true;
    return undefined;
  }

  // Scanning the text

  /** Which checks to run now: all of them, or only those that answer without waiting. */
  private checksToRun(final: boolean): { all: boolean; only: Set<string> | undefined } {
    const { checks, stream } = this.input.compiled;
    const all =
      this.first || final || (this.slow.size > 0 && this.window.sinceSlow >= stream.windowChars);
    const only = all
      ? undefined
      : new Set(checks.filter((check) => !this.slow.has(check.id)).map((check) => check.id));
    return { all, only };
  }

  /** Scans the buffer and returns the replacements to make in it, or a refusal. */
  private async inspect(final: boolean): Promise<Inspected> {
    const { all, only } = this.checksToRun(final);
    if (this.off || (only !== undefined && only.size === 0)) {
      return { pieces: all ? [] : this.window.carry };
    }

    const { buffer } = this.window;
    const ranges = tokenRanges(buffer, this.input.tokens);
    const skip = (_segment: number, span: Span): boolean =>
      span.start !== undefined &&
      span.end !== undefined &&
      ranges.some(([start, end]) => span.start! < end && span.end! > start);

    let result: ScanResult;
    try {
      result = await scan(
        this.input.compiled,
        [{ text: buffer, source: 'output' }],
        this.input.cache,
        { ...this.input.deps, skip, only, memoReadOnly: true },
      );
    } catch (error) {
      const refusal = this.guardFailed(error);
      return refusal === undefined ? { pieces: this.window.carry } : { error: refusal };
    }

    this.take(result);
    if (result.blocked !== undefined) return { error: this.refuse(result.blocked) };
    return { pieces: this.piecesOf(result, all) };
  }

  /** Takes in what a scan reports: time, errors, audit, and which checks turned out slow. */
  private take(result: ScanResult): void {
    this.ms += result.ms;
    const { unscanned: _unscanned, ...phase } = result.report;
    this.lastReport = { ...phase, errors: [], restored: 0, unrestored: 0 };
    this.errors.push(...result.report.errors);
    Object.assign(this.audit, result.report.audit);
    for (const id of result.slow) this.slow.add(id);
  }

  /** The replacements for this scan. Those of slow checks are kept until their text is sent. */
  private piecesOf(result: ScanResult, all: boolean): SpanReplacement[] {
    const { window } = this;
    if (all && this.slow.size > 0) {
      window.slowCovered = window.buffer.length;
      window.sinceSlow = 0;
    }
    this.first = false;

    const found = redactionsOf(result.findings, this.input.compiled.mask);
    if (all) window.carry = found.filter(({ id }) => this.slow.has(id)).map(({ piece }) => piece);

    const pieces = found.map(({ piece }) => piece);
    if (!all) pieces.push(...window.carry);
    return pieces;
  }

  // Text

  /** One step: scan, and send what is safe. */
  private async step(final: boolean): Promise<string | Error> {
    const { window } = this;
    const hasSlow = this.slow.size > 0;

    if (this.input.compiled.stream.release === 'immediate') {
      // Send first, then look: a redaction in what was sent is counted, not made.
      const point = window.releasePoint([], final, hasSlow);
      const text = point > window.sent ? window.send(point, []) : '';
      const outcome = await this.inspect(final);
      if ('error' in outcome) return outcome.error;
      window.countLate(outcome.pieces);
      return text;
    }

    const outcome = await this.inspect(final);
    if ('error' in outcome) return outcome.error;
    const point = window.releasePoint(outcome.pieces, final, hasSlow);
    return point > window.sent ? window.send(point, outcome.pieces) : '';
  }

  private async *onText(delta: string): AsyncGenerator<StreamChunk> {
    this.window.append(delta);
    const out = unwrap(await this.step(false));
    if (out !== '') yield { type: 'text-delta', delta: out };
  }

  // Tool calls

  /** Checks and restores one call's arguments, which are held until complete. */
  private async flushCall(index: number): Promise<StreamChunk | Error> {
    const call = this.calls.get(index)!;
    this.calls.delete(index);

    const { input } = this;
    let answer: Awaited<ReturnType<typeof gateOutput>>;
    try {
      answer = await gateOutput({
        compiled: input.compiled,
        value: call.args,
        tokens: input.tokens,
        cache: input.cache,
        deps: input.deps,
        json: true,
        marker: input.marker,
      });
    } catch (error) {
      const refusal = this.guardFailed(error);
      return refusal ?? toolChunk(index, call, call.args);
    }

    this.ms += answer.ms;
    Object.assign(this.audit, answer.report.audit);
    this.errors.push(...answer.report.errors);
    if (answer.blocked !== undefined) return this.refuse(answer.blocked);
    this.counts.masked += answer.masked;
    return toolChunk(index, call, answer.value as string);
  }

  private async *onToolDelta(chunk: ToolDelta): AsyncGenerator<StreamChunk> {
    // A new call means the earlier ones are complete.
    for (const open of [...this.calls.keys()]) {
      if (open !== chunk.index) yield unwrap(await this.flushCall(open));
    }
    mergeDelta(this.calls, chunk);
    if (chunk.complete === true) yield unwrap(await this.flushCall(chunk.index));
  }

  // The stream

  private async *chunks(): AsyncGenerator<StreamChunk> {
    for await (const chunk of this.input.source.chunks) {
      if (chunk.type === 'text-delta') yield* this.onText(chunk.delta);
      else if (chunk.type === 'tool_call_delta') yield* this.onToolDelta(chunk);
      else yield chunk;
    }

    for (const open of [...this.calls.keys()]) yield unwrap(await this.flushCall(open));
    const rest = unwrap(await this.step(true));
    if (rest !== '') yield { type: 'text-delta', delta: rest };
  }

  /** The whole answer, checked again: authoritative whether or not `chunks` was read. */
  private async onFinal(value: unknown): Promise<unknown> {
    if (this.closed) return value;

    const { input } = this;
    let answer: Awaited<ReturnType<typeof gateOutput>>;
    try {
      answer = await gateOutput({
        compiled: input.compiled,
        value,
        tokens: input.tokens,
        cache: input.cache,
        deps: input.deps,
        marker: input.marker,
      });
    } catch (error) {
      const refusal = this.guardFailed(error);
      if (refusal !== undefined) throw refusal;
      this.settle(false);
      return value;
    }

    this.ms += answer.ms;
    this.counts.masked = Math.max(this.counts.masked, answer.masked);
    if (answer.blocked !== undefined) {
      // The stream let it through, so it is caught here and counted as late.
      this.counts.late++;
      this.closed = true;
      const error = refusalOf(input.compiled.version, answer.blocked);
      this.settle(true, answer.report);
      throw error;
    }
    this.settle(false, answer.report);
    return answer.value;
  }
}

/**
 * The same four steps as a plain answer, over text as it arrives. Text is kept in one buffer: the
 * part not yet sent, and before it up to `holdChars` of what was sent, so a value that straddles
 * the boundary is still seen. Checks that answer synchronously run on every chunk; one that
 * returned a promise once runs per window from then on, and text is not sent past what it covered.
 * Tool call arguments are held until complete. `finalResult` runs the steps on the whole answer, so
 * it is authoritative whether or not `chunks` was read.
 */
export function gateStream(input: StreamGateInput): {
  chunks: AsyncIterable<StreamChunk>;
  finalResult: Promise<unknown>;
} {
  return new StreamGate(input).start();
}
