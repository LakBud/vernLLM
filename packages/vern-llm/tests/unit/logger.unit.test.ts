import { describe, it, expect, vi, afterEach } from 'vitest';

import { ConsoleLogger } from '../../src/logger.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from './../helpers.js';

describe('ConsoleLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gates debug() on the debugEnabled flag', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    new ConsoleLogger(false).debug('hidden');
    expect(spy).not.toHaveBeenCalled();

    new ConsoleLogger(true).debug('shown');
    expect(spy).toHaveBeenCalledWith('shown');
  });

  it('always logs warn() and error() regardless of debugEnabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = new ConsoleLogger(false);
    logger.warn('a warning');
    logger.error('an error', { detail: 1 });

    expect(warnSpy).toHaveBeenCalledWith('a warning');
    expect(errorSpy).toHaveBeenCalledWith('an error', { detail: 1 });
  });
});

describe('VernLLM: injectable logger', () => {
  it('uses a custom logger instead of the console default', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([new Error('boom'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 0, logger });

    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(logger.warn).toHaveBeenCalled(); // retry warning
    expect(logger.debug).toHaveBeenCalled(); // raw output debug line
  });

  it('applies redact to the debug output line even without debug: true, since a custom logger is not gated by that option', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const redact = vi.fn((text: string) => text.replace('secret-token', '[REDACTED]'));
    const { client } = createMockClient([jsonResponse({ token: 'secret-token' })]);
    // No `debug: true` here on purpose: with a custom `logger` supplied,
    // VernLLM calls `logger.debug()` regardless of `debug`, it's the
    // logger's own implementation that decides whether to emit.
    const llm = new VernLLM({ client, model: 'm', logger, redact });

    const result = await llm.call({ userContent: 'u', jsonMode: false });

    expect(result).toContain('secret-token'); // redact never touches the actual return value
    const debugCall = logger.debug.mock.calls.find((c) => String(c[0]).includes('output:'));
    expect(debugCall?.[0]).toContain('[REDACTED]');
    expect(debugCall?.[0]).not.toContain('secret-token');
  });

  it('leaves debug output untouched when redact is not configured', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([jsonResponse({ token: 'secret-token' })]);
    const llm = new VernLLM({ client, model: 'm', logger });

    await llm.call({ userContent: 'u', jsonMode: false });

    const debugCall = logger.debug.mock.calls.find((c) => String(c[0]).includes('output:'));
    expect(debugCall?.[0]).toContain('secret-token');
  });

  it('applies redact to the error debug line on a failed call(), not just the success path', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const redact = vi.fn((text: string) => text.replace('secret-token', '[REDACTED]'));
    const { client } = createMockClient([new Error('provider rejected request: secret-token')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, logger, redact });

    await expect(llm.call({ userContent: 'u' })).rejects.toThrow();

    const debugCall = logger.debug.mock.calls.find((c) => String(c[0]).includes('error:'));
    expect(debugCall?.[0]).toContain('[REDACTED]');
    expect(debugCall?.[0]).not.toContain('secret-token');
  });

  it('applies redact to the stream-open error debug line', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const redact = vi.fn((text: string) => text.replace('secret-token', '[REDACTED]'));
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new Error('not scripted');
          }),
          createStream: vi.fn(() => {
            throw new Error('stream open failed: secret-token');
          }),
        },
      },
    };
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, logger, redact });

    await expect(llm.call({ userContent: 'u', stream: true })).rejects.toThrow();

    const debugCall = logger.debug.mock.calls.find((c) =>
      String(c[0]).includes('stream-open error:'),
    );
    expect(debugCall?.[0]).toContain('[REDACTED]');
    expect(debugCall?.[0]).not.toContain('secret-token');
  });
});

describe('VernLLM: default logger resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to no debug output when debug is not set', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' }); // no logger, no debug
    await llm.call({ userContent: 'u' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('respects debug: true and logs via the default ConsoleLogger', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', debug: true }); // no custom logger
    await llm.call({ userContent: 'u' });
    expect(spy).toHaveBeenCalled();
  });

  it('produces no visible output from redact with the default logger and debug left off, since nothing is logged for it to redact', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const redact = vi.fn((text: string) => text.replace('secret-token', '[REDACTED]'));
    const { client } = createMockClient([jsonResponse({ token: 'secret-token' })]);
    const llm = new VernLLM({ client, model: 'm', redact }); // no logger, no debug
    await llm.call({ userContent: 'u' });
    expect(spy).not.toHaveBeenCalled();
  });
});
