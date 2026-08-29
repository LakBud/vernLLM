import { describe, expect, it, vi } from 'vitest';

import {
  createUsageReporter,
  type UsageReporterOptions,
} from '../../../../src/internal/execution/usageReporter.js';
import { LLMError } from '../../../../src/types/errors.js';

import type { LLMClient, TokenUsage } from '../../../../src/types/index.js';

function fakeLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseOptions(overrides: Partial<UsageReporterOptions> = {}): UsageReporterOptions {
  return {
    providerName: 'openai',
    isFallback: false,
    maxRetries: 3,
    logger: fakeLogger(),
    ...overrides,
  };
}

type RawResponse = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;

function rawResponse(usage: RawResponse['usage']): RawResponse {
  return { choices: [{ message: {} }], usage } as unknown as RawResponse;
}

function baseUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    requestId: 'req-1',
    model: 'gpt-test',
    ...overrides,
  };
}

describe('createUsageReporter, extract', () => {
  it('returns undefined when the response carries no usage block', () => {
    const reporter = createUsageReporter(baseOptions());
    expect(reporter.extract(rawResponse(undefined), 'req-1', 'gpt-test')).toBeUndefined();
  });

  it('extracts prompt/completion/total tokens without a reasoning figure when none is reported', () => {
    const reporter = createUsageReporter(baseOptions());

    const usage = reporter.extract(
      rawResponse({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      'req-1',
      'gpt-test',
    );

    expect(usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(usage).not.toHaveProperty('reasoningTokens');
  });

  it('includes reasoningTokens when the provider reports a reasoning figure', () => {
    const reporter = createUsageReporter(baseOptions());

    const usage = reporter.extract(
      rawResponse({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 4 },
      }),
      'req-1',
      'gpt-test',
    );

    expect(usage?.reasoningTokens).toBe(4);
  });

  it('defaults missing prompt/completion/total fields to 0 rather than undefined', () => {
    const reporter = createUsageReporter(baseOptions());

    const usage = reporter.extract(rawResponse({}), 'req-1', 'gpt-test');

    expect(usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('carries requestId and model through from the call site, not the response', () => {
    const reporter = createUsageReporter(baseOptions());

    const usage = reporter.extract(
      rawResponse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      'req-carried',
      'model-carried',
    );

    expect(usage).toMatchObject({ requestId: 'req-carried', model: 'model-carried' });
  });

  it('stamps provider from providerName and usedFallback false for a primary target', () => {
    const reporter = createUsageReporter(
      baseOptions({ providerName: 'anthropic', isFallback: false }),
    );

    const usage = reporter.extract(
      rawResponse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      'req-1',
      'claude-x',
    );

    expect(usage).toMatchObject({ provider: 'anthropic', usedFallback: false });
  });

  it('stamps usedFallback true for a fallback target', () => {
    const reporter = createUsageReporter(baseOptions({ isFallback: true }));

    const usage = reporter.extract(
      rawResponse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      'req-1',
      'gpt-test',
    );

    expect(usage?.usedFallback).toBe(true);
  });
});

describe('createUsageReporter, actualTokensFor', () => {
  it('returns undefined when usage itself is undefined', () => {
    const reporter = createUsageReporter(baseOptions());
    expect(reporter.actualTokensFor(undefined)).toBeUndefined();
  });

  it('uses totalTokens when it is nonzero', () => {
    const reporter = createUsageReporter(baseOptions());
    const usage = baseUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(reporter.actualTokensFor(usage)).toBe(15);
  });

  it('falls back to promptTokens + completionTokens when totalTokens is 0', () => {
    const reporter = createUsageReporter(baseOptions());
    const usage = baseUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 0 });
    expect(reporter.actualTokensFor(usage)).toBe(15);
  });
});

describe('createUsageReporter, reportSuccess', () => {
  it('does nothing when usage is undefined', () => {
    const onUsage = vi.fn();
    const reporter = createUsageReporter(baseOptions({ onUsage }));
    reporter.reportSuccess(undefined);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does nothing when no onUsage hook was configured', () => {
    const reporter = createUsageReporter(baseOptions());
    expect(() => reporter.reportSuccess(baseUsage())).not.toThrow();
  });

  it('calls onUsage with the usage', () => {
    const onUsage = vi.fn();
    const reporter = createUsageReporter(baseOptions({ onUsage }));
    const usage = baseUsage();

    reporter.reportSuccess(usage);

    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it('swallows and logs an error thrown by onUsage, instead of propagating it', () => {
    const logger = fakeLogger();
    const onUsage = vi.fn(() => {
      throw new Error('onUsage boom');
    });
    const reporter = createUsageReporter(baseOptions({ onUsage, logger }));

    expect(() => reporter.reportSuccess(baseUsage())).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onUsage failed', {
      message: 'onUsage boom',
    });
  });
});

describe('createUsageReporter, reportFailure', () => {
  it('logs a retryable-style attempt count when not terminal', () => {
    const logger = fakeLogger();
    const reporter = createUsageReporter(baseOptions({ logger, maxRetries: 4 }));

    reporter.reportFailure(baseUsage(), new LLMError('boom', 'api'), 1);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('attempt 2/5'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('mid-stream'));
  });

  it('logs the terminal mid-stream wording when terminal is true, instead of an attempt count', () => {
    const logger = fakeLogger();
    const reporter = createUsageReporter(baseOptions({ logger }));

    reporter.reportFailure(baseUsage(), new LLMError('boom', 'timeout'), 0, true);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('mid-stream failure (terminal, no further attempts)'),
    );
  });

  it('logs totalTokens when nonzero', () => {
    const logger = fakeLogger();
    const reporter = createUsageReporter(baseOptions({ logger }));

    reporter.reportFailure(
      baseUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
      new LLMError('boom', 'api'),
      0,
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tokens=15'));
  });

  it('falls back to promptTokens + completionTokens in the log when totalTokens is 0', () => {
    const logger = fakeLogger();
    const reporter = createUsageReporter(baseOptions({ logger }));

    reporter.reportFailure(
      baseUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 0 }),
      new LLMError('boom', 'api'),
      0,
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tokens=15'));
  });

  it('does nothing beyond logging when no onUsageFailure hook was configured', () => {
    const reporter = createUsageReporter(baseOptions());
    expect(() => reporter.reportFailure(baseUsage(), new LLMError('boom', 'api'), 0)).not.toThrow();
  });

  it('calls onUsageFailure with the usage and error', () => {
    const onUsageFailure = vi.fn();
    const reporter = createUsageReporter(baseOptions({ onUsageFailure }));
    const usage = baseUsage();
    const error = new LLMError('boom', 'api');

    reporter.reportFailure(usage, error, 0);

    expect(onUsageFailure).toHaveBeenCalledExactlyOnceWith(usage, error);
  });

  it('swallows and logs an error thrown by onUsageFailure, instead of propagating it', () => {
    const logger = fakeLogger();
    const onUsageFailure = vi.fn(() => {
      throw new Error('onUsageFailure boom');
    });
    const reporter = createUsageReporter(baseOptions({ onUsageFailure, logger }));

    expect(() => reporter.reportFailure(baseUsage(), new LLMError('boom', 'api'), 0)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onUsageFailure failed', {
      message: 'onUsageFailure boom',
    });
  });
});
