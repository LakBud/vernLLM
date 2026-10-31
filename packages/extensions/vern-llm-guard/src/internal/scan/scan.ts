import { ScanRun } from './scanRun.js';

import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { InputSegment } from '../segments/types.js';
import type { CallCache, ScanDeps, ScanResult } from './types.js';

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
  segments: readonly InputSegment[],
  cache: CallCache,
  deps: ScanDeps,
): ScanResult | Promise<ScanResult> {
  return new ScanRun(compiled, segments, cache, deps).run();
}
