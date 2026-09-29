import { describe, it, expect, vi } from 'vitest';

import { type AnthropicClient, fromAnthropic } from '../../../../src/adapters/index.js';
import { VernLLM, type RateLimiterAdapter } from '../../../../src/index.js';
import { at, makeFakeAnthropicClient } from '../../../helpers.js';

describe('fromAnthropic', () => {
  it("passes through an omitted temperature without crashing, so the caller can defer to Anthropic's own default", async () => {
    const { client, create } = makeFakeAnthropicClient('hi there');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in create.mock.calls[0]![0]).toBe(false);
  });

  it('maps system + user messages into Anthropic system/messages shape', async () => {
    const { client, create } = makeFakeAnthropicClient('hi there');
    const adapted = fromAnthropic(client);
    const controller = new AbortController();

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.5,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal: controller.signal },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-x',
        max_tokens: 100,
        temperature: 0.5,
        system: 'be nice',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { signal: controller.signal },
    );
  });

  it('returns content in the chat.completions.create shape', async () => {
    const { client } = makeFakeAnthropicClient('the answer');
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('the answer');
  });

  it('maps usage from input_tokens/output_tokens to prompt/completion/total', async () => {
    const { client } = makeFakeAnthropicClient('x', { input_tokens: 7, output_tokens: 3 });
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt_tokens_details: {},
    });
  });

  it('counts cache reads and writes as prompt tokens, and reports the split', async () => {
    const { client } = makeFakeAnthropicClient('x', {
      input_tokens: 7,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 5000,
      output_tokens: 3,
    } as never);

    const result = await fromAnthropic(client).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 6207,
      completion_tokens: 3,
      total_tokens: 6210,
      prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 1200 },
    });
  });

  it('splits cache writes by TTL', async () => {
    const { client } = makeFakeAnthropicClient('x', {
      input_tokens: 7,
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 1200, ephemeral_1h_input_tokens: 800 },
      output_tokens: 3,
    } as never);

    const result = await fromAnthropic(client).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage?.prompt_tokens_details).toEqual({
      cache_write_tokens: 2000,
      cache_write_tokens_by_ttl: { '5m': 1200, '1h': 800 },
    });
  });

  it('counts a missing or non finite TTL bucket as 0', async () => {
    const { client } = makeFakeAnthropicClient('x', {
      input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: NaN },
      output_tokens: 3,
    } as never);

    const result = await fromAnthropic(client).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage?.prompt_tokens_details?.cache_write_tokens_by_ttl).toEqual({
      '5m': 0,
      '1h': 0,
    });
  });

  it('omits the TTL split when cache_creation is null', async () => {
    const { client } = makeFakeAnthropicClient('x', {
      input_tokens: 7,
      cache_creation: null,
      output_tokens: 3,
    } as never);

    const result = await fromAnthropic(client).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage?.prompt_tokens_details).not.toHaveProperty('cache_write_tokens_by_ttl');
  });

  it('reports no cache split when the response carries no usage', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'x' }] }));

    const result = await fromAnthropic({ messages: { create } } as never).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage?.prompt_tokens).toBeUndefined();
    expect(result.usage?.prompt_tokens_details).toBeUndefined();
  });

  it.each([
    ['a null cache write count', { input_tokens: 7, cache_creation_input_tokens: null }, 7],
    ['a non finite cache write count', { input_tokens: 7, cache_creation_input_tokens: NaN }, 7],
    ['a null cache read count', { input_tokens: 7, cache_read_input_tokens: null }, 7],
    ['a non finite cache read count', { input_tokens: 7, cache_read_input_tokens: NaN }, 7],
    ['cache writes without input_tokens', { cache_creation_input_tokens: 40 }, 40],
    ['cache reads without input_tokens', { cache_read_input_tokens: 500 }, 500],
    ['no input counts at all', {}, undefined],
  ])('handles %s', async (_label, usage, expected) => {
    const { client } = makeFakeAnthropicClient('x', { ...usage, output_tokens: 3 } as never);

    const result = await fromAnthropic(client).chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage?.prompt_tokens).toBe(expected);
    expect(result.usage?.total_tokens).toBe((expected ?? 0) + 3);
  });

  it('translates ContentBlock[] userContent into Anthropic image/text blocks', async () => {
    const { client, create } = makeFakeAnthropicClient('described');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "what's in this image?" },
              { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];
    expect(sentParams.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: "what's in this image?" },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZWJhc2U2NA==' },
          },
        ],
      },
    ]);
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
          temperature: 0.2,
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/tiff' }],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });
  });

  it('works with no system message at all', async () => {
    const { client, create } = makeFakeAnthropicClient('ok');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].system).toBeUndefined();
  });

  it('preserves assistant turns and ordering for multi-turn conversations', async () => {
    const { client, create } = makeFakeAnthropicClient('Paris has about 2.1 million people.');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].messages).toEqual([
      { role: 'user', content: "What's the capital of France?" },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: "What's its population?" },
    ]);
  });

  it('defaults a plain user/assistant message with no content at all to an empty string', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 10,
        messages: [{ role: 'assistant' } as unknown as { role: 'assistant'; content: string }],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].messages).toEqual([{ role: 'assistant', content: '' }]);
  });
});

describe('fromAnthropic, stop reason', () => {
  const request = {
    model: 'claude-x',
    max_tokens: 10,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('reports finish_reason length when Anthropic stopped at max_tokens', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: '{"a":' }],
      stop_reason: 'max_tokens',
    }));

    const result = await fromAnthropic({ messages: { create } }).chat.completions.create(request, {
      signal: new AbortController().signal,
    });

    expect(result.choices?.[0]?.finish_reason).toBe('length');
  });

  it('leaves finish_reason out for any other stop reason', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    }));

    const result = await fromAnthropic({ messages: { create } }).chat.completions.create(request, {
      signal: new AbortController().signal,
    });

    expect(result.choices?.[0]).not.toHaveProperty('finish_reason');
  });
});

describe('fromAnthropic, prompt caching and the rate limiter', () => {
  it('reconciles the limiter against cache writes too', async () => {
    const { client } = makeFakeAnthropicClient('x', {
      input_tokens: 10,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 8000,
      output_tokens: 5,
    } as never);
    const release = vi.fn();
    const rateLimit: RateLimiterAdapter = {
      estimate: () => 50,
      acquire: async () => ({ release, waitedMs: 0 }),
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    const llm = new VernLLM({ client: fromAnthropic(client), model: 'claude-x', rateLimit });
    await llm.call({ userContent: 'hi', jsonMode: false });

    expect(release).toHaveBeenCalledWith(2015, true);
  });
});
