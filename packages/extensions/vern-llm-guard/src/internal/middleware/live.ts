import { randomBytes } from 'node:crypto';

import { createGuard, type Guard } from '../guard.utils.js';
import { compile } from '../options/compile.utils.js';
import { createMemo } from '../scan/memo.utils.js';

import type { GuardOptions } from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { Memo } from '../scan/types.js';

/** What a new call starts on. `update` swaps it whole; a call keeps the one it read. */
export interface Live {
  readonly compiled: CompiledChecks;
  /** The options as they now stand, so an update can build on them. */
  readonly options: GuardOptions;
  readonly memo: Memo | undefined;
  /** Shared by every `Live` of one middleware, so an update does not reset its warnings. */
  readonly guard: Guard;
  /** Shared too: tokens must stay the same across an update. */
  readonly key: Uint8Array;
}

export function createLive(
  options: GuardOptions,
  shared?: { guard: Guard; key: Uint8Array },
): Live {
  const compiled = compile(options);
  return {
    compiled,
    options,
    memo: createMemo(compiled.memoMax),
    guard: shared?.guard ?? createGuard(options.logger),
    key: shared?.key ?? compiled.key ?? randomBytes(32),
  };
}
