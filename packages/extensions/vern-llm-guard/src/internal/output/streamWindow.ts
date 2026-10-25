import { replaceSpans } from '../segments/replaceSpans.utils.js';
import { unmark } from '../spotlight/spotlight.js';
import { restoreTokens, tokenizeKnown, tokenRanges, type TokenMap } from '../tokens/tokens.js';
import { advance, startState, stringAt } from './json.utils.js';
import { boundaryBefore, commonPrefix, notInPair, tailStart } from './streamText.utils.js';

import type { SpanReplacement } from '../segments/types.js';

/** What a stream counts as it goes, for the one result of the call. */
export interface StreamCounts {
  /** Values an `output` check replaced for good. */
  masked: number;
  /** Findings in text that had already been sent. */
  late: number;
}

export interface WindowOptions {
  holdChars: number;
  release: 'checked' | 'immediate';
  /** The text is JSON, so a restored value is escaped to keep it valid. */
  json: boolean;
  /** A spotlight marker the model may have echoed. It is removed as the text arrives. */
  marker: string | undefined;
  tokens: TokenMap;
}

/**
 * The text of a stream between the provider and the caller. It is kept in one buffer: the part not
 * yet sent, and before it up to `holdChars` of what was sent, so a value that straddles the
 * boundary is still seen. It decides how much of that is safe to send, and sends it with
 * replacements made and tokens restored. It knows nothing of the checks.
 */
export class TextWindow {
  /** The text, tokenized. Everything before `sent` has been sent and is kept only as context. */
  buffer = '';
  sent = 0;
  /** How far the slow checks have read. */
  slowCovered = 0;
  /** New text since the slow checks last ran. */
  sinceSlow = 0;
  /** Redactions found by slow checks, kept until the text they are in is sent. */
  carry: SpanReplacement[] = [];

  /** What came off the front of `buffer` already, so a position means the same thing throughout. */
  private trimmed = 0;
  private readonly lateAt = new Set<number>();
  /** Where redactions were made in text that was sent, by absolute position. */
  private readonly maskedAt = new Set<number>();
  /** Where `buffer` starts, if the text is JSON: whether that is inside a string. */
  private readonly jsonStart = startState();

  constructor(
    private readonly options: WindowOptions,
    private readonly counts: StreamCounts,
  ) {}

  /** Adds text, tokenizes what is known in it, and keeps positions that still mean the same. */
  append(delta: string): void {
    const before = this.buffer;
    this.buffer = tokenizeKnown(unmark(before + delta, this.options.marker), this.options.tokens);
    const unchanged = commonPrefix(before, this.buffer);
    if (unchanged < before.length) {
      this.slowCovered = Math.min(this.slowCovered, unchanged);
      this.carry = this.carry.filter((piece) => piece.end <= unchanged);
    }
    this.sinceSlow += delta.length;
  }

  /** Where sending may stop, in `buffer`, given the replacements; `-1` for nowhere yet. */
  releasePoint(pieces: readonly SpanReplacement[], final: boolean, hasSlow: boolean): number {
    const { buffer, sent } = this;
    if (final) return buffer.length;

    const { holdChars, release, marker, tokens } = this.options;
    if (release === 'immediate') return Math.min(buffer.length, tailStart(buffer, marker));

    let limit = buffer.length - holdChars;
    if (hasSlow) limit = Math.min(limit, this.slowCovered);
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
    const open = tailStart(buffer, marker);
    for (let pass = 0; pass < 2; pass++) {
      for (const [start, end] of spans) {
        if (start >= sent && start < point && end > point) point = start;
      }
      if (open < point) point = open;
    }
    return point > sent ? point : -1;
  }

  /** Sends `buffer` up to `point`, with replacements made and tokens restored. */
  send(point: number, pieces: readonly SpanReplacement[]): string {
    const { json, tokens } = this.options;
    const { buffer, sent } = this;

    const inside = pieces
      .filter((piece) => piece.start >= sent && piece.end <= point)
      .map((piece) => {
        this.maskedAt.add(this.trimmed + piece.start);
        // Outside a JSON string a mask has to be one, or the document stops being JSON.
        const text =
          json && !stringAt(this.jsonStart, buffer, piece.start)
            ? JSON.stringify(piece.text)
            : piece.text;
        return { start: piece.start - sent, end: piece.end - sent, text };
      });
    this.counts.masked += inside.length;

    // A replacement that began in text already sent cannot be made; it is counted as late, unless
    // it was made when that text went out and is only being seen again as context.
    for (const piece of pieces) {
      const at = this.trimmed + piece.start;
      if (piece.start < sent && !this.lateAt.has(at) && !this.maskedAt.has(at)) {
        this.lateAt.add(at);
        this.counts.late++;
      }
    }

    const text = restoreTokens(replaceSpans(buffer.slice(sent, point), inside), tokens, {
      json,
    }).text;
    this.sent = point;
    this.trim();
    return text;
  }

  /** Counts redactions in text that was already sent: with `immediate` they are seen, not made. */
  countLate(pieces: readonly SpanReplacement[]): void {
    for (const piece of pieces) {
      const at = this.trimmed + piece.start;
      if (!this.lateAt.has(at)) {
        this.lateAt.add(at);
        this.counts.late++;
      }
    }
  }

  /** Drops what is sent and further back than `holdChars`, moving every position with it. */
  private trim(): void {
    const cut = Math.max(0, this.sent - this.options.holdChars);
    if (cut === 0) return;

    if (this.options.json) advance(this.jsonStart, this.buffer.slice(0, cut));
    this.buffer = this.buffer.slice(cut);
    this.sent -= cut;
    this.trimmed += cut;
    this.slowCovered = Math.max(0, this.slowCovered - cut);
    this.carry = this.carry
      .map((piece) => ({ ...piece, start: piece.start - cut, end: piece.end - cut }))
      .filter((piece) => piece.end > 0);
  }
}
