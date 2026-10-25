import { scan } from '../scan/scan.js';
import { applyReplacements } from '../segments/applyReplacements.utils.js';
import { outputSegments } from '../segments/outputSegments.utils.js';
import { replaceSpans } from '../segments/replaceSpans.utils.js';
import { unmark } from '../spotlight/spotlight.js';
import { restoreTokens, tokenizeKnown, tokenRanges } from '../tokens/tokens.js';
import { startState, stringAt } from './json.utils.js';

import type { OutputReport, Segment } from '../../types/index.js';
import type { CompiledCheck } from '../../types/resolvedConfig.js';
import type { Span } from '../scan/types.js';
import type { Replacement } from '../segments/types.js';
import type { GateInput, GateResult } from './types.js';

/**
 * The same four steps for every answer, in this order:
 *
 * 1. Tokenize known values: raw values the request held become their tokens, so a target that was
 *    given the raw text answers like any other.
 * 2. Check: output checks scan what is left. A token that stands for something the user sent is
 *    skipped, so the checks see what the model introduced, not what the user wrote.
 * 3. Act: a block refuses, a redact replaces the finding with the mask text.
 * 4. Restore: tokens become values again, or the mask text for a check with `restore: false`.
 */
export async function gateOutput(input: GateInput): Promise<GateResult> {
  const { compiled, value, tokens } = input;

  const extracted = outputSegments(value);
  const original = extracted.segments.map((segment) => segment.text);
  const tokenized = original.map((text) => tokenizeKnown(unmark(text, input.marker), tokens));
  const segments: Segment[] = tokenized.map((text) => ({ text, source: 'output' }));

  const ranges = tokenized.map((text) => tokenRanges(text, tokens));
  const skip = (segment: number, span: Span, check: CompiledCheck): boolean =>
    // Text that must go back verbatim cannot be masked, so a redaction there has nothing to do.
    (check.action === 'redact' && extracted.fixed[segment] === true) ||
    (span.start !== undefined &&
      span.end !== undefined &&
      (ranges[segment] ?? []).some(([start, end]) => span.start! < end && span.end! > start));

  const scanned = await scan(compiled, segments, input.cache, { ...input.deps, skip });
  const { unscanned: _unscanned, ...phase } = scanned.report;
  const report: OutputReport = { ...phase, restored: 0, unrestored: 0 };

  if (scanned.blocked !== undefined) {
    return { value, report, blocked: scanned.blocked, masked: 0, ms: scanned.ms };
  }

  const pieces = new Map<number, { start: number; end: number; text: string }[]>();
  let masked = 0;
  for (const { check, segment, span } of scanned.findings) {
    // The scan blocked a redact check whose findings it could not locate, so these have offsets.
    if (check.action !== 'redact') continue;
    const start = span.start!;
    const end = span.end!;
    const list = pieces.get(segment) ?? [];
    const mask = compiled.mask(span.label ?? check.label);
    // Outside a JSON string a mask has to be one, or the document stops being JSON.
    const text =
      input.json === true && !stringAt(startState(), tokenized[segment]!, start)
        ? JSON.stringify(mask)
        : mask;
    list.push({ start, end, text });
    pieces.set(segment, list);
    masked++;
  }

  const replacements: Replacement[] = [];
  tokenized.forEach((text, index) => {
    if (extracted.fixed[index]) return;
    const acted = replaceSpans(text, pieces.get(index) ?? []);
    const restored = restoreTokens(acted, tokens, { json: input.json === true });
    report.restored += restored.restored;
    report.unrestored += restored.unrestored;

    if (restored.text !== original[index]) {
      replacements.push({
        segment: index,
        start: 0,
        end: original[index]!.length,
        text: restored.text,
      });
    }
  });

  return {
    value: replacements.length === 0 ? value : applyReplacements(value, extracted, replacements),
    report,
    masked,
    ms: scanned.ms,
  };
}
