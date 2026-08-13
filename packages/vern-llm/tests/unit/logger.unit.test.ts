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

  it('applies redact to the debug output line, not to the returned result', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const redact = vi.fn((text: string) => text.replace('secret-token', '[REDACTED]'));
    const { client } = createMockClient([jsonResponse({ token: 'secret-token' })]);
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
});
