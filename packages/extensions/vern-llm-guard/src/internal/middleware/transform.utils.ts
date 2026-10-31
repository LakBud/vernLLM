import { contentBlocked } from '../contentBlocked.utils.js';
import { scan } from '../scan/scan.js';
import { applyReplacements } from '../segments/applyReplacements.utils.js';
import { requestSegments } from '../segments/requestSegments.utils.js';
import { hasMarkable, spotlight } from '../spotlight/spotlight.js';
import { tokenFor } from '../tokens/tokens.js';
import { STATE, redactsFor, type CallState } from './state.js';

import type { GuardMiddleware, Segment } from '../../types/index.js';
import type { Replacement } from '../segments/types.js';
import type { Live } from './live.js';

/**
 * Runs for each attempt, after every other transform: scans what they added, redacts for this
 * attempt's target, and marks text for spotlight.
 */
export function createTransform(getLive: () => Live): NonNullable<GuardMiddleware['transform']> {
  const { guard, key } = getLive();

  return async (request, ctx) => {
    const state = ctx.own[STATE] as CallState | undefined;
    // `wrap` did not run, or failed open: the call runs unguarded.
    if (state === undefined) return {};

    const names = ctx.transformMiddlewareNames;
    if (names[names.length - 1] !== 'guard') {
      guard.warnOnce(
        'order',
        'a transform runs after the guard, so what it adds reaches the provider unchecked. Give the guard the last place',
      );
    }

    try {
      const extracted = requestSegments(request.messages, { images: state.compiled.images });
      const scanned = await scan(state.compiled, extracted.segments, state.cache, {
        memo: state.memo,
        ctx,
        signal: ctx.signal,
        deadlineAt: ctx.deadlineAt,
        only: state.compiled.serial,
      });

      // Whatever is found here was added after policy decided, so it cannot change the labels.
      state.input.late += scanned.fresh;
      state.ms += scanned.ms;
      for (const error of scanned.report.errors) {
        if (!state.input.errors.some((e) => e.check === error.check && e.name === error.name)) {
          state.input.errors.push(error);
        }
      }

      if (scanned.blocked !== undefined) {
        state.refused = true;
        throw contentBlocked(
          state.compiled.version,
          'input',
          scanned.blocked.check,
          scanned.blocked.label === undefined ? [] : [scanned.blocked.label],
          scanned.blocked.failed,
        );
      }

      const replacements: Replacement[] = [];
      for (const { check, segment, span } of scanned.findings) {
        if (check.action !== 'redact') continue;
        if (!redactsFor(check, ctx)) continue;

        const { start, end } = { start: span.start!, end: span.end! };
        const label = span.label ?? check.label;
        const token = tokenFor(
          state.tokens,
          key,
          label,
          (extracted.segments[segment] as Segment).text.slice(start, end),
          check.restore ? undefined : state.compiled.mask(label),
        );
        replacements.push({ segment, start, end, text: token });
      }

      let messages = request.messages;
      if (replacements.length > 0) {
        state.redacted += replacements.length;
        messages = applyReplacements(messages, extracted, replacements);
      }
      // After redaction, which finds values by their position in the text as it was sent.
      if (state.compiled.spotlight !== undefined && state.marker !== undefined) {
        // Text another transform added is marked too, so an answer may echo the marker.
        if (hasMarkable(messages, state.compiled.spotlight)) state.marked = true;
        messages = spotlight(messages, state.compiled.spotlight, state.marker);
      }
      return messages === request.messages ? {} : { messages };
    } catch (error) {
      if (state.refused) throw error;

      guard.report('transform', error);
      if (!state.compiled.failClosed) return {};

      state.refused = true;
      throw contentBlocked(state.compiled.version, 'input', undefined, [], true);
    }
  };
}
