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

describe('VernLLM — injectable logger', () => {
  it('uses a custom logger instead of the console default', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([new Error('boom'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 0, logger });

    await llm.call({ systemPrompt: 's', userContent: 'u' });

    expect(logger.warn).toHaveBeenCalled(); // retry warning
    expect(logger.debug).toHaveBeenCalled(); // raw output debug line
  });
});
