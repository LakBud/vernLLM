import { replaceSpans } from '../segments/replaceSpans.utils.js';
import { isThenable } from '../thenable.utils.js';

import type { Finding } from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { SpanReplacement } from '../segments/types.js';

const noop = (): void => {};

/**
 * Masks what the `redact` and `block` checks find in `text`, whatever they are pointed at: a log
 * line is not a request or an answer. It is synchronous, so a check that answers with a promise is
 * left out. When a check that must not fail cannot say what is in the text, or finds something it
 * cannot locate, the whole text is masked. Never throws.
 */
export function redactText(compiled: CompiledChecks, text: string): string {
  if (text === '') return text;

  const everything = compiled.mask('redacted');
  const segments = [{ text, source: 'output' as const }];
  const pieces: SpanReplacement[] = [];

  for (const check of compiled.checks) {
    if (check.audit || check.action === 'label') continue;

    const controller = new AbortController();
    let found: unknown;
    try {
      found = check.detect(segments, controller.signal);
    } catch {
      if (check.failClosed) return everything;
      continue;
    }

    if (isThenable(found)) {
      controller.abort();
      found.then(noop, noop);
      continue;
    }
    if (!Array.isArray(found)) {
      if (check.failClosed) return everything;
      continue;
    }

    for (const entry of found as Partial<Finding>[]) {
      const { start, end } = entry ?? {};
      if (
        entry?.segment !== 0 ||
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > text.length
      ) {
        // Something is there that cannot be located.
        if (entry?.segment === 0) return everything;
        continue;
      }
      pieces.push({ start, end, text: compiled.mask(entry.label ?? check.label) });
    }
  }

  return replaceSpans(text, pieces);
}
