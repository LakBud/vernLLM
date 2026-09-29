import { vi } from 'vitest';

import type { Logger } from '../../../../../../src/logger.js';
import type { AttemptContext } from '../../../../../../src/types/index.js';
import type { WireCallRequest } from '../../../../../../src/types/middleware.js';

export const baseRequest: WireCallRequest = {
  model: 'gpt-4o',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

export function baseCtx(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    stage: 'attempt',
    requestId: 'req-1',
    adapter: { name: 'custom' },
    requestedProvider: 'primary',
    requestedModel: 'gpt-4o',
    isFallbackAttempt: false,
    attempt: 1,
    capabilities: { supportsJsonObjectMode: true },
    state: { get: () => undefined, set: () => {} },
    own: {},
    emit: vi.fn(),
    context: undefined,
    registeredMiddlewareNames: [],
    transformMiddlewareNames: [],
    ...overrides,
  };
}

export const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
