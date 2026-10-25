import { vi } from 'vitest';

import { type RunOperationDependencies } from '../../../../../../src/internal/execution/runOperation.js';
import { buildMiddlewarePipeline } from '../../../../../../src/internal/resolveMiddlewareOrder.js';

import type { CallExecutor } from '../../../../../../src/internal/execution/callExecutor.js';
import type { ResolvedTarget } from '../../../../../../src/internal/execution/targetOrder.js';
import type { Logger } from '../../../../../../src/logger.js';
import type { CallParams, VernLLMMiddleware } from '../../../../../../src/types/index.js';

/**
 * Only `providerName`, `model`, and `previewRequest` are ever touched by
 * `runOperation`; everything else is intentionally absent so a test
 * fails loudly if `runOperation` starts relying on something new.
 */
function fakePrimaryExecutor(): CallExecutor {
  return {
    providerName: 'primary',
    model: 'default-model',
    adapter: { name: 'fake' },
    jsonObjectModeSupported: true,
    previewRequest: () => ({
      model: 'default-model',
      request: { model: 'default-model', max_tokens: 100, messages: [] },
    }),
  } as unknown as CallExecutor;
}

export function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export const primary = fakePrimaryExecutor();
export const declared: ResolvedTarget[] = [{ executor: primary, index: 0 }];

export function dependencies(
  overrides: Partial<Omit<RunOperationDependencies, 'pipeline' | 'primaryExecutor'>> & {
    middleware?: VernLLMMiddleware[];
  } = {},
): RunOperationDependencies {
  return {
    pipeline: buildMiddlewarePipeline(overrides.middleware ?? []),
    primaryExecutor: primary,
    targets: overrides.targets ?? declared,
    middlewareTimeoutMs: overrides.middlewareTimeoutMs ?? 5000,
    logger: overrides.logger ?? fakeLogger(),
    reportEvent: overrides.reportEvent ?? (() => {}),
  };
}

export const params: CallParams<unknown> = { userContent: 'hi', jsonMode: false };
export const requestId = 'req-1';
