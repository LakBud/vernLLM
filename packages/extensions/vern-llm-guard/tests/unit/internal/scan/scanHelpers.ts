import { vi } from 'vitest';

import { compile } from '../../../../src/internal/options/compile.utils.js';
import { createMemo } from '../../../../src/internal/scan/memo.utils.js';
import { scan } from '../../../../src/internal/scan/scan.js';

import type {
  Check,
  Detector,
  Finding,
  ImageDetector,
  ImageSegment,
  Segment,
} from '../../../../src/index.js';
import type { CallCache, ScanResult } from '../../../../src/internal/scan/types.js';

export const user = (text: string): Segment => ({ text, source: 'user' });

/** An image segment of the user, as the guard cuts one out of a content block. */
export const image = (data: string, source: ImageSegment['source'] = 'user'): ImageSegment => ({
  image: { data, mimeType: 'image/png' },
  source,
});

/** A detector that takes images, and finds `label` in each one. It remembers what it was given. */
export function readsImages(label = 'pic') {
  const calls: (Segment | ImageSegment)[][] = [];
  const detect: ImageDetector = Object.assign(
    (segments: readonly (Segment | ImageSegment)[]): Finding[] => {
      calls.push([...segments]);
      return segments.flatMap((segment, index): Finding[] =>
        'image' in segment ? [{ segment: index, label }] : [],
      );
    },
    { images: true as const },
  );
  return { detect: vi.fn(detect) as unknown as ImageDetector, calls };
}
export const tool = (text: string): Segment => ({ text, source: 'tool' });

/** A detector that finds `needle` in every segment, and remembers what it was given. */
export function finds(needle: string, kind = 'hit') {
  const calls: Segment[][] = [];
  const detect: Detector = (segments) => {
    calls.push([...segments]);
    return segments.flatMap((segment, index): Finding[] => {
      const start = segment.text.indexOf(needle);
      return start === -1
        ? []
        : [{ segment: index, label: kind, start, end: start + needle.length }];
    });
  };
  return { detect: vi.fn(detect), calls };
}

export const later = <T>(value: T, ms = 0): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export function setup(
  checks: Check[],
  options: { onError?: 'open' | 'closed'; version?: string } = {},
) {
  const compiled = compile({ version: options.version ?? 'v1', checks, ...options });
  const cache: CallCache = new Map();
  const memo = createMemo(100);
  const run = (
    segments: (Segment | ImageSegment)[],
    deps: Partial<Parameters<typeof scan>[3]> = {},
  ): ScanResult | Promise<ScanResult> =>
    scan(compiled, segments, cache, {
      memo,
      ctx: { context: undefined, streaming: false },
      ...deps,
    });
  return { compiled, cache, memo, run };
}

export const isPromise = (value: unknown): boolean => value instanceof Promise;
