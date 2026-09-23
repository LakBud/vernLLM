import { describe, it, expect, vi } from 'vitest';

import {
  fromCerebras,
  fromDeepInfra,
  fromDeepSeek,
  fromFireworks,
  fromGroq,
  fromHyperbolic,
  fromLMStudio,
  fromMistral,
  fromMoonshot,
  fromNovita,
  fromOllama,
  fromOpenAI,
  fromOpenAICompatible,
  fromOpenRouter,
  fromPerplexity,
  fromTogether,
  fromVLLM,
  fromZhipu,
  fromXAI,
  fromNvidiaNIM,
  fromVercelAIGateway,
  fromCloudflareWorkersAI,
  fromNebius,
  fromSambaNova,
  fromBaseten,
  fromFeatherless,
  fromFriendli,
  fromSiliconFlow,
  fromParasail,
  fromStepFun,
  fromMiniMax,
  fromLambdaLabs,
  fromSnowflakeCortex,
  fromAnyscale,
  fromLepton,
  fromInferenceNet,
  fromInfermatic,
  fromAtlasCloud,
  from01AI,
} from '../../../../src/adapters/index.js';

describe('fromOpenAICompatible and its aliases', () => {
  it('delegates create() to the underlying client, forwarding params/options untouched for string content', async () => {
    let received: unknown;
    let receivedOptions: unknown;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: unknown, options: unknown) => {
            received = params;
            receivedOptions = options;
            return { choices: [{ message: { content: 'ok' } }] };
          },
        },
      },
    };
    const adapted = fromOpenAICompatible(fakeClient);
    const controller = new AbortController();
    const params = {
      model: 'm',
      temperature: 0.2,
      max_tokens: 10,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };
    const result = await adapted.chat.completions.create(params, { signal: controller.signal });
    expect(received).toEqual(params);
    expect(receivedOptions).toEqual({ signal: controller.signal });
    expect(result.choices?.[0]?.message?.content).toBe('ok');
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const fakeClient = {
      chat: {
        completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) },
      },
    };
    const adapted = fromOpenAICompatible(fakeClient);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
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

  it('translates ContentBlock[] userContent into OpenAI text/image_url parts', async () => {
    let received: { messages: unknown } | undefined;
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: { messages: unknown }, _options: unknown) => {
            received = params;
            return { choices: [{ message: { content: 'ok' } }] };
          },
        },
      },
    };

    const adapted = fromOpenAICompatible(fakeClient);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
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

    expect(received?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: "what's in this image?" },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZWJhc2U2NA==' } },
        ],
      },
    ]);
  });

  it('leaves successful tool message content unchanged', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] }));
    const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'fine', is_error: false }],
      },
      { signal: new AbortController().signal },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'fine' }],
      }),
      expect.anything(),
    );
  });

  describe('json_object keyword', () => {
    function makeAdapted() {
      const create = vi.fn(async () => ({ choices: [{ message: { content: '{}' } }] }));
      return { create, adapted: fromOpenAICompatible({ chat: { completions: { create } } }) };
    }

    it('prepends a JSON instruction when no message mentions json', async () => {
      const { create, adapted } = makeAdapted();

      await adapted.chat.completions.create(
        {
          model: 'gpt-4o',
          max_tokens: 10,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'List three colors.' },
          ],
        },
        { signal: new AbortController().signal },
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'Respond with a valid JSON object.' },
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'List three colors.' },
          ],
        }),
        expect.anything(),
      );
    });

    it('leaves messages untouched when a text part already mentions JSON', async () => {
      const { create, adapted } = makeAdapted();
      const messages = [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Reply as Json please.' }],
        },
      ];

      await adapted.chat.completions.create(
        { model: 'gpt-4o', max_tokens: 10, response_format: { type: 'json_object' }, messages },
        { signal: new AbortController().signal },
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply as Json please.' }] }],
        }),
        expect.anything(),
      );
    });

    it('ignores json appearing only inside image base64 data', async () => {
      const { create, adapted } = makeAdapted();

      await adapted.chat.completions.create(
        {
          model: 'gpt-4o',
          max_tokens: 10,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this.' },
                { type: 'image', mimeType: 'image/png', data: 'aGVsbG8json' },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      );

      const sent = (create.mock.calls[0] as unknown as [{ messages: unknown[] }])[0];
      expect(sent.messages[0]).toEqual({
        role: 'system',
        content: 'Respond with a valid JSON object.',
      });
    });

    it('does not add an instruction for json_schema or plain text', async () => {
      const { create, adapted } = makeAdapted();

      await adapted.chat.completions.create(
        { model: 'gpt-4o', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      );
      await adapted.chat.completions.create(
        {
          model: 'gpt-4o',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'S', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      for (const call of create.mock.calls as unknown as [{ messages: unknown[] }][]) {
        expect(call[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
      }
    });
  });

  describe('reasoning model params', () => {
    function makeAdapted() {
      const create = vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] }));
      return { create, adapted: fromOpenAICompatible({ chat: { completions: { create } } }) };
    }

    it.each([
      'o1',
      'o3',
      'o3-mini',
      'o4-mini-2025-04-16',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.2-pro',
      'gpt-5.6-sol',
      'gpt-6-sol',
      'gpt-6-astra',
      'gpt-10',
    ])('sends max_completion_tokens and no temperature for %s', async (model) => {
      const { create, adapted } = makeAdapted();

      await adapted.chat.completions.create(
        {
          model,
          temperature: 0.2,
          max_tokens: 1000,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sent = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(sent.max_completion_tokens).toBe(1000);
      expect(sent).not.toHaveProperty('max_tokens');
      expect(sent).not.toHaveProperty('temperature');
    });

    it.each([
      'gpt-4o',
      'gpt-4.1-mini',
      'gpt-3.5-turbo',
      'gpt-5.2-chat-latest',
      'openai/o3',
      'openai/gpt-6-sol',
      'llama-3.3-70b',
      'omni-x',
    ])('leaves max_tokens and temperature alone for %s', async (model) => {
      const { create, adapted } = makeAdapted();

      await adapted.chat.completions.create(
        { model, temperature: 0.2, max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      );

      const sent = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(sent).toMatchObject({ max_tokens: 1000, temperature: 0.2 });
      expect(sent).not.toHaveProperty('max_completion_tokens');
    });

    it('rewrites the streaming request the same way', async () => {
      const create = vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'ok' } }] };
        },
      }));
      const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

      for await (const _chunk of adapted.chat.completions.createStream!(
        {
          model: 'o3',
          temperature: 0.2,
          max_tokens: 50,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      )) {
        // drain
      }

      const sent = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(sent).toMatchObject({ max_completion_tokens: 50, stream: true });
      expect(sent).not.toHaveProperty('max_tokens');
      expect(sent).not.toHaveProperty('temperature');
      expect((sent.messages as unknown[])[0]).toEqual({
        role: 'system',
        content: 'Respond with a valid JSON object.',
      });
    });
  });

  it('strips is_error and keeps the failure in the tool message content', async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: 'ok' } }],
    }));

    const adapted = fromOpenAICompatible({
      chat: {
        completions: {
          create,
        },
      },
    });

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'failed',
            is_error: true,
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'Error: failed',
          },
        ],
      }),
      expect.anything(),
    );
  });

  it.each([
    ['fromOpenAI', fromOpenAI],
    ['fromGroq', fromGroq],
    ['fromMistral', fromMistral],
    ['fromDeepSeek', fromDeepSeek],
    ['fromCerebras', fromCerebras],
    ['fromTogether', fromTogether],
    ['fromFireworks', fromFireworks],
    ['fromOllama', fromOllama],
    ['fromOpenRouter', fromOpenRouter],
    ['fromPerplexity', fromPerplexity],
    ['fromDeepInfra', fromDeepInfra],
    ['fromNovita', fromNovita],
    ['fromHyperbolic', fromHyperbolic],
    ['fromMoonshot', fromMoonshot],
    ['fromZhipu', fromZhipu],
    ['fromLMStudio', fromLMStudio],
    ['fromVLLM', fromVLLM],
    ['fromXAI', fromXAI],
    ['fromNvidiaNIM', fromNvidiaNIM],
    ['fromVercelAIGateway', fromVercelAIGateway],
    ['fromCloudflareWorkersAI', fromCloudflareWorkersAI],
    ['fromNebius', fromNebius],
    ['fromSambaNova', fromSambaNova],
    ['fromBaseten', fromBaseten],
    ['fromFeatherless', fromFeatherless],
    ['fromFriendli', fromFriendli],
    ['fromSiliconFlow', fromSiliconFlow],
    ['fromParasail', fromParasail],
    ['fromStepFun', fromStepFun],
    ['fromMiniMax', fromMiniMax],
    ['fromLambdaLabs', fromLambdaLabs],
    ['fromSnowflakeCortex', fromSnowflakeCortex],
    ['fromAnyscale', fromAnyscale],
    ['fromLepton', fromLepton],
    ['fromInferenceNet', fromInferenceNet],
    ['fromInfermatic', fromInfermatic],
    ['fromAtlasCloud', fromAtlasCloud],
    ['from01AI', from01AI],
  ])('%s is an alias for fromOpenAICompatible', (_name, fn) => {
    expect(fn).toBe(fromOpenAICompatible);
  });
});

describe('fromOpenAICompatible, supportsWithResponse', () => {
  function fakeHeaders(values: Record<string, string>) {
    return { get: (name: string) => values[name.toLowerCase()] ?? null };
  }

  it('does not attach a rate limit hint when the resolved data is not an object', async () => {
    const create = vi.fn().mockReturnValue({
      withResponse: async () => ({
        data: 'not-an-object',
        response: { headers: fakeHeaders({ 'x-ratelimit-remaining-requests': '5' }) },
      }),
    });
    const adapted = fromOpenAICompatible(
      { chat: { completions: { create } } },
      { supportsWithResponse: true },
    );

    const result = await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result).toBe('not-an-object');
  });

  it('does not yield a rate_limit_hint chunk when neither remainingRequests nor limitRequests is present', async () => {
    const create = vi.fn().mockReturnValue({
      withResponse: async () => ({
        data: (async function* () {
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        })(),
        response: { headers: fakeHeaders({}) },
      }),
    });
    const adapted = fromOpenAICompatible(
      { chat: { completions: { create } } },
      { supportsWithResponse: true },
    );

    const chunks: unknown[] = [];
    for await (const chunk of adapted.chat.completions.createStream!(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => (c as { type?: string }).type === 'rate_limit_hint')).toBe(false);
  });

  it('yields a rate_limit_hint chunk when only limitRequests is present', async () => {
    const create = vi.fn().mockReturnValue({
      withResponse: async () => ({
        data: (async function* () {
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        })(),
        response: { headers: fakeHeaders({ 'x-ratelimit-limit-requests': '100' }) },
      }),
    });
    const adapted = fromOpenAICompatible(
      { chat: { completions: { create } } },
      { supportsWithResponse: true },
    );

    const chunks: unknown[] = [];
    for await (const chunk of adapted.chat.completions.createStream!(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toMatchObject({ type: 'rate_limit_hint', hint: { limitRequests: 100 } });
  });
});
