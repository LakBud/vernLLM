import { GUARD_RESULT_EVENT } from '../../events.js';
import { contentBlocked } from '../contentBlocked.utils.js';
import { errorName } from '../errors.utils.js';
import { scan } from '../scan/scan.js';
import { isImage } from '../segments/isImage.utils.js';
import { requestSegments } from '../segments/requestSegments.utils.js';
import { hasMarkable, markerFor } from '../spotlight/spotlight.js';
import { createTokenMap, tokenFor } from '../tokens/tokens.js';
import { STATE, type CallState } from './state.js';

import type { GuardResult, Segment } from '../../types/index.js';
import type { CallCache, ScanResult } from '../scan/types.js';
import type { InputSegment } from '../segments/types.js';
import type { Live } from './live.js';
import type { JsonValue, LLMError, PreDispatchContext, WireCallRequest } from 'vern-llm';

/** What the scan of a request leaves for the rest of the call. */
export interface Started {
  state: CallState;
  /** The request as the caller sent it, for the checks that run alongside the call. */
  inputSegments: InputSegment[];
  /** The image segments some check read, shared with the checks that run alongside the call. */
  covered: Set<number>;
  /** Sets the report's count of unscanned things, once every check that reads images has run. */
  recount: () => void;
  /** Set when an enforced check refused the call. */
  refusal: LLMError | undefined;
}

/**
 * Scans the request and makes the state of the call. Resolves to the error instead of throwing when
 * the guard itself fails, which a check's `onError` does not cover.
 */
export async function scanRequest(
  live: Live,
  request: WireCallRequest,
  ctx: PreDispatchContext,
): Promise<Started | { error: unknown }> {
  const { compiled, memo, key } = live;
  let refusal: LLMError | undefined;

  try {
    const extracted = requestSegments(request.messages, { images: compiled.images });
    const cache: CallCache = new Map();
    const covered = new Set<number>();
    const scanned: ScanResult = await scan(compiled, extracted.segments, cache, {
      memo,
      ctx,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      // The checks that run alongside the call start after this.
      only: compiled.serial,
      covered,
    });

    // An image that no check read is as unscanned as one that was never cut out.
    const images = extracted.segments.filter(isImage).length;
    const recount = (): void => {
      scanned.report.unscanned = extracted.unscanned + images - covered.size;
    };
    recount();

    // One token per value, from the request as the caller sent it. A raw target may echo a value
    // it was given, and it is tokenized from this map when the answer comes back.
    const tokens = createTokenMap();
    if (scanned.blocked === undefined) {
      for (const { check, segment, span } of scanned.findings) {
        if (check.action !== 'redact') continue;
        // An image has no offsets, so a redact check on one blocked the call and never gets here.
        const text = (extracted.segments[segment] as Segment).text;
        const label = span.label ?? check.label;
        tokenFor(
          tokens,
          key,
          label,
          text.slice(span.start!, span.end),
          check.restore ? undefined : compiled.mask(label),
        );
      }
    }

    const state: CallState = {
      compiled,
      memo,
      marker: compiled.spotlight === undefined ? undefined : markerFor(key, compiled.version),
      marked: compiled.spotlight !== undefined && hasMarkable(request.messages, compiled.spotlight),
      cache,
      tokens,
      inputText: extracted.segments.filter((segment): segment is Segment => !isImage(segment)),
      labels: scanned.unknown ? undefined : scanned.labels,
      input: scanned.report,
      ms: scanned.ms,
      redacted: 0,
      masked: 0,
      refused: false,
    };
    ctx.own[STATE] = state;

    if (scanned.blocked !== undefined) {
      refusal = contentBlocked(
        compiled.version,
        'input',
        scanned.blocked.check,
        scanned.blocked.label === undefined ? [] : [scanned.blocked.label],
        scanned.blocked.failed,
      );
    }

    return { state, inputSegments: extracted.segments, covered, recount, refusal };
  } catch (error) {
    return { error };
  }
}

/** The refusal for a request the guard could not scan, after it emitted the call's one result. */
export function refuseStart(live: Live, ctx: PreDispatchContext, error: unknown): LLMError {
  const { version } = live.compiled;
  ctx.emit(GUARD_RESULT_EVENT, {
    v: 1,
    version,
    outcome: 'blocked',
    input: {
      checks: {},
      audit: {},
      errors: [{ name: errorName(error) }],
      late: 0,
      unscanned: 0,
    },
  } satisfies GuardResult as unknown as JsonValue);
  return contentBlocked(version, 'input', undefined, [], true);
}
