import { contentBlocked } from '../contentBlocked.utils.js';
import { errorName } from '../errors.utils.js';
import { scan } from '../scan/scan.js';
import { replaceSpans } from '../segments/replaceSpans.utils.js';
import { unmark } from '../spotlight/spotlight.js';
import { restoreTokens, tokenizeKnown, tokenRanges } from '../tokens/tokens.js';
import { gateOutput } from './gate.js';
import { advance, startState, stringAt, type JsonState } from './json.utils.js';
import {
  boundaryBefore,
  commonPrefix,
  emptyReport,
  notInPair,
  partialTokenStart,
  unique,
} from './streamText.utils.js';

import type { AuditEffect, CheckError, OutputReport } from '../../types/index.js';
import type { ScanResult, Span } from '../scan/types.js';
import type { SpanReplacement } from '../segments/types.js';
import type { StreamGateInput } from './types.js';
import type { StreamChunk } from 'vern-llm';

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
  const { compiled, source, tokens } = input;
  const { holdChars, windowChars, release } = compiled.stream;

  /** The text, tokenized. Everything before `sent` has been sent and is kept only as context. */
  let buffer = '';
  let sent = 0;
  /** What came off the front of `buffer` already, so a position means the same thing throughout. */
  let trimmed = 0;
  const slow = new Set<string>();
  /** How far the slow checks have read. */
  let slowCovered = 0;
  let sinceSlow = 0;
  let first = true;
  /** Redactions found by slow checks, kept until the text they are in is sent. */
  let carry: SpanReplacement[] = [];

  let ms = 0;
  let masked = 0;
  let late = 0;
  const lateAt = new Set<number>();
  /** Where redactions were made in text that was sent, by absolute position. */
  const maskedAt = new Set<number>();
  /** Where `buffer` starts, if the text is JSON: whether that is inside a string. */
  const jsonStart: JsonState = startState();
  const errors: CheckError[] = [];
  const audit: Record<string, AuditEffect> = {};
  let lastReport = emptyReport();
  let off = false;
  let settled = false;
  let closed = false;

  const settle = (blocked: boolean, report?: OutputReport): void => {
    if (settled) return;
    settled = true;
    const base = report ?? lastReport;
    input.onDone({
      report: {
        ...base,
        audit: { ...base.audit, ...audit },
        errors: unique([...base.errors, ...errors]),
        late: base.late + late,
      },
      masked,
      ms,
      blocked,
    });
  };

  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});

  /** Ends the stream with a refusal that `chunks` throws and `finalResult` rejects with. */
  const refuse = (blocked: ScanResult['blocked'] | undefined): Error => {
    closed = true;
    const error = contentBlocked(
      compiled.version,
      'output',
      blocked?.check,
      blocked?.label === undefined ? [] : [blocked.label],
      blocked?.failed ?? true,
    );
    settle(true);
    rejectFailure(error);
    return error;
  };

  const guardFailed = (error: unknown): Error | undefined => {
    errors.push({ name: errorName(error) });
    if (compiled.failClosed) return refuse(undefined);
    off = true;
    return undefined;
  };

  /** Scans `buffer`. Returns the replacements to make in it, or a refusal. */
  const inspect = async (
    final: boolean,
  ): Promise<{ pieces: SpanReplacement[] } | { error: Error }> => {
    const all = first || final || (slow.size > 0 && sinceSlow >= windowChars);
    const only = all
      ? undefined
      : new Set(compiled.checks.filter((check) => !slow.has(check.id)).map((c) => c.id));
    if (off || (only !== undefined && only.size === 0)) return { pieces: all ? [] : carry };

    const ranges = tokenRanges(buffer, tokens);
    const skip = (_segment: number, span: Span): boolean =>
      span.start !== undefined &&
      span.end !== undefined &&
      ranges.some(([start, end]) => span.start! < end && span.end! > start);

    let result: ScanResult;
    try {
      result = await scan(compiled, [{ text: buffer, source: 'output' }], input.cache, {
        ...input.deps,
        skip,
        only,
        memoReadOnly: true,
      });
    } catch (error) {
      const refusal = guardFailed(error);
      return refusal === undefined ? { pieces: carry } : { error: refusal };
    }

    ms += result.ms;
    const { unscanned: _unscanned, ...phase } = result.report;
    lastReport = { ...phase, errors: [], restored: 0, unrestored: 0 };
    errors.push(...result.report.errors);
    Object.assign(audit, result.report.audit);
    for (const id of result.slow) slow.add(id);

    if (result.blocked !== undefined) return { error: refuse(result.blocked) };

    if (all && slow.size > 0) {
      slowCovered = buffer.length;
      sinceSlow = 0;
    }
    first = false;

    const found: { id: string; piece: SpanReplacement }[] = [];
    for (const { check, span } of result.findings) {
      if (check.action !== 'redact') continue;
      found.push({
        id: check.id,
        piece: {
          start: span.start!,
          end: span.end!,
          text: compiled.mask(span.label ?? check.label),
        },
      });
    }
    if (all) carry = found.filter(({ id }) => slow.has(id)).map(({ piece }) => piece);

    const pieces = found.map(({ piece }) => piece);
    if (!all) pieces.push(...carry);
    return { pieces };
  };

  /** Where text that has only started to arrive begins: a token, or the first symbol of a marker. */
  const tailStart = (text: string): number => {
    // Half of a surrogate pair is held too, so a character is never split between two chunks.
    const code = text.charCodeAt(text.length - 1);
    if (code >= 0xd800 && code <= 0xdbff) return text.length - 1;
    const token = partialTokenStart(text);
    const marker = input.marker;
    return marker !== undefined && text.endsWith(marker[0]!) && !text.endsWith(marker)
      ? Math.min(token, text.length - 1)
      : token;
  };

  /** Where sending may stop, in `buffer`, given the replacements; `-1` for nowhere yet. */
  const releasePoint = (pieces: readonly SpanReplacement[], final: boolean): number => {
    if (final) return buffer.length;

    if (release === 'immediate') return Math.min(buffer.length, tailStart(buffer));

    let limit = buffer.length - holdChars;
    if (slow.size > 0) limit = Math.min(limit, slowCovered);
    if (limit <= sent) return -1;

    let point = boundaryBefore(buffer, sent, limit);
    // Text with no whitespace in it, such as Chinese or Japanese, is sent in steps of `holdChars`.
    // A boundary is not needed for correctness: values and tokens that straddle it are kept back
    // below, and the end stays held.
    if (point === -1) point = limit - sent >= holdChars ? limit : -1;
    if (point === -1) return -1;
    point = notInPair(buffer, point, sent);

    const spans: [number, number][] = [
      ...pieces.map((piece): [number, number] => [piece.start, piece.end]),
      ...tokenRanges(buffer, tokens),
    ];
    const open = tailStart(buffer);
    for (let pass = 0; pass < 2; pass++) {
      for (const [start, end] of spans) {
        if (start >= sent && start < point && end > point) point = start;
      }
      if (open < point) point = open;
    }
    return point > sent ? point : -1;
  };

  /** Sends `buffer` up to `point`, with replacements made and tokens restored. */
  const send = (point: number, pieces: readonly SpanReplacement[]): string => {
    const inside = pieces
      .filter((piece) => piece.start >= sent && piece.end <= point)
      .map((piece) => {
        maskedAt.add(trimmed + piece.start);
        // Outside a JSON string a mask has to be one, or the document stops being JSON.
        const text =
          input.json && !stringAt(jsonStart, buffer, piece.start)
            ? JSON.stringify(piece.text)
            : piece.text;
        return { start: piece.start - sent, end: piece.end - sent, text };
      });
    masked += inside.length;

    // A replacement that began in text already sent cannot be made; it is counted as late, unless
    // it was made when that text went out and is only being seen again as context.
    for (const piece of pieces) {
      const at = trimmed + piece.start;
      if (piece.start < sent && !lateAt.has(at) && !maskedAt.has(at)) {
        lateAt.add(at);
        late++;
      }
    }

    const text = restoreTokens(replaceSpans(buffer.slice(sent, point), inside), tokens, {
      json: input.json,
    }).text;
    sent = point;

    const cut = Math.max(0, sent - holdChars);
    if (cut > 0) {
      if (input.json) advance(jsonStart, buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      sent -= cut;
      trimmed += cut;
      slowCovered = Math.max(0, slowCovered - cut);
      carry = carry
        .map((piece) => ({ ...piece, start: piece.start - cut, end: piece.end - cut }))
        .filter((piece) => piece.end > 0);
    }
    return text;
  };

  /** Adds text, tokenizes what is known in it, and keeps positions that still mean the same. */
  const append = (delta: string): void => {
    const before = buffer;
    buffer = tokenizeKnown(unmark(buffer + delta, input.marker), tokens);
    const unchanged = commonPrefix(before, buffer);
    if (unchanged < before.length) {
      slowCovered = Math.min(slowCovered, unchanged);
      carry = carry.filter((piece) => piece.end <= unchanged);
    }
    sinceSlow += delta.length;
  };

  /** One step: scan, and send what is safe. */
  const step = async (final: boolean): Promise<string | Error> => {
    if (release === 'immediate') {
      const point = releasePoint([], final);
      const text = point > sent ? send(point, []) : '';
      const outcome = await inspect(final);
      if ('error' in outcome) return outcome.error;
      // Redactions in text that was already sent are counted, not made.
      for (const piece of outcome.pieces) {
        if (!lateAt.has(trimmed + piece.start)) {
          lateAt.add(trimmed + piece.start);
          late++;
        }
      }
      return text;
    }

    const outcome = await inspect(final);
    if ('error' in outcome) return outcome.error;
    const point = releasePoint(outcome.pieces, final);
    return point > sent ? send(point, outcome.pieces) : '';
  };

  const calls = new Map<number, { id?: string; name?: string; args: string }>();

  /** Checks and restores one call's arguments, which are held until complete. */
  const flushCall = async (index: number): Promise<StreamChunk | Error> => {
    const call = calls.get(index)!;
    calls.delete(index);

    let answer: Awaited<ReturnType<typeof gateOutput>>;
    try {
      answer = await gateOutput({
        compiled,
        value: call.args,
        tokens,
        cache: input.cache,
        deps: input.deps,
        json: true,
        marker: input.marker,
      });
    } catch (error) {
      const refusal = guardFailed(error);
      if (refusal !== undefined) return refusal;
      return toolChunk(index, call, call.args);
    }
    ms += answer.ms;
    Object.assign(audit, answer.report.audit);
    errors.push(...answer.report.errors);
    if (answer.blocked !== undefined) return refuse(answer.blocked);
    masked += answer.masked;
    return toolChunk(index, call, answer.value as string);
  };

  const toolChunk = (
    index: number,
    call: { id?: string; name?: string },
    args: string,
  ): StreamChunk => ({
    type: 'tool_call_delta',
    index,
    ...(call.id !== undefined && { id: call.id }),
    ...(call.name !== undefined && { name: call.name }),
    argsDelta: args,
    complete: true,
  });

  async function* chunks(): AsyncGenerator<StreamChunk> {
    for await (const chunk of source.chunks) {
      if (chunk.type === 'text-delta') {
        append(chunk.delta);
        const out = await step(false);
        if (out instanceof Error) throw out;
        if (out !== '') yield { type: 'text-delta', delta: out };
      } else if (chunk.type === 'tool_call_delta') {
        // A new call means the earlier ones are complete.
        for (const open of [...calls.keys()]) {
          if (open === chunk.index) continue;
          const done = await flushCall(open);
          if (done instanceof Error) throw done;
          yield done;
        }
        const call = calls.get(chunk.index) ?? { args: '' };
        if (chunk.id !== undefined) call.id = chunk.id;
        if (chunk.name !== undefined) call.name = chunk.name;
        if (chunk.argsDelta !== undefined) {
          call.args = chunk.complete === true ? chunk.argsDelta : call.args + chunk.argsDelta;
        }
        calls.set(chunk.index, call);
        if (chunk.complete === true) {
          const done = await flushCall(chunk.index);
          if (done instanceof Error) throw done;
          yield done;
        }
      } else {
        yield chunk;
      }
    }

    for (const open of [...calls.keys()]) {
      const done = await flushCall(open);
      if (done instanceof Error) throw done;
      yield done;
    }
    const rest = await step(true);
    if (rest instanceof Error) throw rest;
    if (rest !== '') yield { type: 'text-delta', delta: rest };
  }

  const onFinal = async (value: unknown): Promise<unknown> => {
    if (closed) return value;

    let answer: Awaited<ReturnType<typeof gateOutput>>;
    try {
      answer = await gateOutput({
        compiled,
        value,
        tokens,
        cache: input.cache,
        deps: input.deps,
        marker: input.marker,
      });
    } catch (error) {
      const refusal = guardFailed(error);
      if (refusal !== undefined) throw refusal;
      settle(false);
      return value;
    }

    ms += answer.ms;
    masked = Math.max(masked, answer.masked);
    if (answer.blocked !== undefined) {
      // The stream let it through, so it is caught here and counted as late.
      late++;
      closed = true;
      const error = contentBlocked(
        compiled.version,
        'output',
        answer.blocked.check,
        answer.blocked.label === undefined ? [] : [answer.blocked.label],
        answer.blocked.failed,
      );
      settle(true, answer.report);
      throw error;
    }
    settle(false, answer.report);
    return answer.value;
  };

  const finalResult = Promise.race([
    source.finalResult.then(onFinal, (error: unknown) => {
      // The provider failed, or the caller left: the call still gets its one result.
      settle(false);
      throw error;
    }),
    failure,
  ]);
  finalResult.catch(() => {});

  return { chunks: { [Symbol.asyncIterator]: chunks }, finalResult };
}
