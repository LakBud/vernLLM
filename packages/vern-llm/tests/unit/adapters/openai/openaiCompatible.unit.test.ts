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

  it('strips is_error from tool messages for OpenAI-compatible providers', async () => {
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
            content: 'failed',
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
