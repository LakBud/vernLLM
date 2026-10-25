import { describe, expect, it } from 'vitest';

import { runOperation } from '../../../../../../src/internal/execution/runOperation.js';
import { LLMError } from '../../../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../../../src/types/middleware.js';
import { declared, dependencies, fakeLogger, params, requestId } from './runOperation.helpers.js';

import type { VernLLMMiddleware } from '../../../../../../src/types/index.js';

describe('runOperation, a wrap refusing a result', () => {
  const refusal = () =>
    new LLMError('Call blocked: content refused by middleware "refuser"', 'invalid_params', {
      code: 'content_blocked',
    });

  it('Rule 3: rethrows content_blocked thrown after next() resolved, without logging it as a bug', async () => {
    const logger = fakeLogger();
    const error = refusal();
    const middleware: VernLLMMiddleware = {
      name: 'refuser',
      wrap: async (_request, next) => {
        await next();
        throw error;
      },
    };

    await expect(
      runOperation(
        dependencies({ middleware: [middleware], logger }),
        params,
        requestId,
        createMiddlewareStateBag(),
        declared,
        async () => ({ value: 'resolved' }),
      ),
    ).rejects.toBe(error);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('Rule 3: still keeps the result when the throw after next() is any other LLMError', async () => {
    const logger = fakeLogger();
    const middleware: VernLLMMiddleware = {
      name: 'mw',
      wrap: async (_request, next) => {
        await next();
        throw new LLMError('denied', 'invalid_params', { code: 'policy_denied' });
      },
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], logger }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'resolved' }),
    );

    expect(outcome).toEqual({ value: 'resolved' });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('passes content_blocked through an outer wrap that called next()', async () => {
    const error = refusal();
    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: -10,
      wrap: async (_request, next) => next(),
    };
    const refuser: VernLLMMiddleware = {
      name: 'refuser',
      position: 10,
      wrap: async (_request, next) => {
        await next();
        throw error;
      },
    };

    await expect(
      runOperation(
        dependencies({ middleware: [outer, refuser] }),
        params,
        requestId,
        createMiddlewareStateBag(),
        declared,
        async () => ({ value: 'resolved' }),
      ),
    ).rejects.toBe(error);
  });
});
