import { describe, expect, it, vi } from 'vitest';

import { fromOpenAICompatible } from '../../../../src/adapters/index.js';
import { LLMError, VernLLM, type Logger } from '../../../../src/index.js';

import type { LLMClient } from '../../../../src/types/index.js';

type Request = Parameters<LLMClient['chat']['completions']['create']>[0];

const signal = new AbortController().signal;

const tools: Request['tools'] = [
  {
    type: 'function',
    function: { name: 'lookup', description: 'Looks up', parameters: { type: 'object' } },
  },
];

function openAI() {
  const create = vi.fn(async (_params: unknown, _options: unknown) => ({
    choices: [{ message: { content: 'ok' } }],
  }));
  return { client: { chat: { completions: { create } } }, create };
}

function sent(create: ReturnType<typeof openAI>['create']): Record<string, unknown> {
  return create.mock.calls[0]![0] as Record<string, unknown>;
}

function request(model: string, extra: Partial<Request> = {}): Request {
  return { model, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

describe('fromOpenAICompatible, tools on models that need reasoning_effort "none"', () => {
  it('sends "none" when tools are present and no reasoning was asked for', async () => {
    const { client, create } = openAI();

    await fromOpenAICompatible(client).chat.completions.create(request('gpt-6', { tools }), {
      signal,
    });

    expect(sent(create).reasoning_effort).toBe('none');
  });

  it('logs the switch at debug level once a logger is set', async () => {
    const { client } = openAI();
    const adapter = fromOpenAICompatible(client);
    const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    adapter.setLogger!(logger);

    await adapter.chat.completions.create(request('gpt-6-sol', { tools }), { signal });

    expect(logger.debug).toHaveBeenCalledWith(
      '[VernLLM] gpt-6-sol: sending reasoning_effort "none", required for tools on Chat Completions',
    );
  });

  it('leaves a request without tools unchanged', async () => {
    const { client, create } = openAI();

    await fromOpenAICompatible(client).chat.completions.create(
      request('gpt-6', { reasoning_effort: 'high' }),
      { signal },
    );

    expect(sent(create).reasoning_effort).toBe('high');
  });

  it.each([
    ['reasoning_effort', { reasoning_effort: 'low' as const }],
    ['budget_tokens', { budget_tokens: 4000 }],
  ])('throws locally when %s is set alongside tools', async (_label, extra) => {
    const { client, create } = openAI();

    const error = await fromOpenAICompatible(client)
      .chat.completions.create(request('gpt-6', { tools, ...extra }), { signal })
      .catch((e: unknown) => e);

    expect(create).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'tools_with_reasoning' },
    });
    expect((error as LLMError).message).toContain('reasoningEffort: null');
    expect((error as LLMError).message).toContain('Responses API');
  });

  it.each(['gpt-5', 'gpt-6-chat-latest', 'openai/gpt-6', 'o4-mini'])(
    'leaves %s alone',
    async (model) => {
      const { client, create } = openAI();

      await fromOpenAICompatible(client).chat.completions.create(
        request(model, { tools, reasoning_effort: 'low' }),
        { signal },
      );

      expect(sent(create).reasoning_effort).toBe('low');
    },
  );

  it('applies to gpt-7 as well', async () => {
    const { client, create } = openAI();

    await fromOpenAICompatible(client).chat.completions.create(request('gpt-7', { tools }), {
      signal,
    });

    expect(sent(create).reasoning_effort).toBe('none');
  });

  it('lets the override replace the built in rule', async () => {
    const { client, create } = openAI();
    const adapter = fromOpenAICompatible(client, {
      noReasoningToolModels: ['my-deployment'],
    });

    await adapter.chat.completions.create(request('my-deployment', { tools }), { signal });
    await adapter.chat.completions.create(request('gpt-6', { tools, reasoning_effort: 'low' }), {
      signal,
    });

    expect((create.mock.calls[0]![0] as Request).reasoning_effort).toBe('none');
    expect((create.mock.calls[1]![0] as Request).reasoning_effort).toBe('low');
  });

  it('accepts a predicate override', async () => {
    const { client, create } = openAI();

    await fromOpenAICompatible(client, {
      noReasoningToolModels: (model) => model.endsWith('-tools'),
    }).chat.completions.create(request('azure-tools', { tools }), { signal });

    expect(sent(create).reasoning_effort).toBe('none');
  });

  it('sends "none" on a stream too', async () => {
    const create = vi.fn(async (_params: unknown, _options: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'ok' } }] };
      },
    }));
    const adapter = fromOpenAICompatible({ chat: { completions: { create } } });

    for await (const _chunk of adapter.chat.completions.createStream!(request('gpt-6', { tools }), {
      signal,
    })) {
      // draining only
    }

    expect((create.mock.calls[0]![0] as Request).reasoning_effort).toBe('none');
  });

  it('throws on a stream before opening it', async () => {
    const create = vi.fn();
    const adapter = fromOpenAICompatible({ chat: { completions: { create } } });

    const stream = adapter.chat.completions.createStream!(
      request('gpt-6', { tools, budget_tokens: 2000 }),
      { signal },
    );

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('fromOpenAICompatible through VernLLM, gpt-6 with tools', () => {
  const tool = { name: 'lookup', description: 'Looks up', parameters: { type: 'object' } };

  it('throws for an instance default reasoning effort, without a retry or a request', async () => {
    const { client, create } = openAI();
    const llm = new VernLLM({
      client: fromOpenAICompatible(client),
      model: 'gpt-6',
      defaultReasoningEffort: 'medium',
      maxRetries: 3,
      circuitBreaker: { threshold: 1 },
      logger: 'silent',
    });

    await expect(llm.call({ userContent: 'hi', tools: [tool] })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(create).not.toHaveBeenCalled();
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('sends "none" once the call clears the instance default with null', async () => {
    const { client, create } = openAI();
    const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const llm = new VernLLM({
      client: fromOpenAICompatible(client),
      model: 'gpt-6',
      defaultReasoningEffort: 'medium',
      logger,
    });

    await llm.call({ userContent: 'hi', tools: [tool], reasoningEffort: null, jsonMode: false });

    expect(sent(create).reasoning_effort).toBe('none');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('reasoning_effort "none"'));
  });
});

describe('client.setLogger', () => {
  it('is called with the instance logger, and a throwing one is logged, not thrown', () => {
    const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client: LLMClient = {
      setLogger: vi.fn(() => {
        throw new Error('nope');
      }),
      chat: { completions: { create: vi.fn() } },
    };

    expect(() => new VernLLM({ client, model: 'm', logger })).not.toThrow();
    expect(client.setLogger).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] client.setLogger failed',
      expect.objectContaining({ message: 'nope' }),
    );
  });
});
