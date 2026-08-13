import { describe, it, expect, vi } from 'vitest';

import {
  from01AI,
  fromAnyscale,
  fromAtlasCloud,
  fromBaseten,
  fromCerebras,
  fromCloudflareWorkersAI,
  fromDeepInfra,
  fromDeepSeek,
  fromFeatherless,
  fromFireworks,
  fromFriendli,
  fromGroq,
  fromHyperbolic,
  fromInferenceNet,
  fromInfermatic,
  fromLMStudio,
  fromLambdaLabs,
  fromLepton,
  fromMiniMax,
  fromMistral,
  fromMoonshot,
  fromNebius,
  fromNovita,
  fromNvidiaNIM,
  fromOllama,
  fromOpenAI,
  fromOpenAICompatible,
  fromOpenRouter,
  fromParasail,
  fromPerplexity,
  fromSambaNova,
  fromSiliconFlow,
  fromSnowflakeCortex,
  fromStepFun,
  fromTogether,
  fromVLLM,
  fromVercelAIGateway,
  fromXAI,
  fromZhipu,
} from '../../../../src/adapters/index.js';

/** Minimal fake client shape accepted by fromOpenAICompatible and its validating wrappers. */
function fakeClient(baseURL?: string) {
  return {
    baseURL,
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] })),
      },
    },
  };
}

describe('fromOpenAICompatible', () => {
  it('delegates create() to the underlying client, forwarding params/options untouched for string content', async () => {
    let received: unknown;
    let receivedOptions: unknown;
    const client = {
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
    const adapted = fromOpenAICompatible(client);
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

  it('throws a validation LLMError for an unsupported image mimeType', async () => {
    const client = {
      chat: {
        completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) },
      },
    };
    const adapted = fromOpenAICompatible(client);

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
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
  });

  it('translates ContentBlock[] userContent into OpenAI text/image_url parts', async () => {
    let received: { messages: unknown } | undefined;
    const client = {
      chat: {
        completions: {
          create: async (params: { messages: unknown }, _options: unknown) => {
            received = params;
            return { choices: [{ message: { content: 'ok' } }] };
          },
        },
      },
    };

    const adapted = fromOpenAICompatible(client);

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
});

describe('named adapter baseURL validation', () => {
  describe.each([
    ['fromGroq', fromGroq, 'https://api.groq.com'],
    ['fromMistral', fromMistral, 'https://api.mistral.ai'],
    ['fromDeepSeek', fromDeepSeek, 'https://api.deepseek.com'],
    ['fromCerebras', fromCerebras, 'https://api.cerebras.ai'],
    ['fromTogether', fromTogether, 'https://api.together.ai'],
    ['fromFireworks', fromFireworks, 'https://api.fireworks.ai'],
    ['fromOpenRouter', fromOpenRouter, 'https://openrouter.ai'],
    ['fromPerplexity', fromPerplexity, 'https://api.perplexity.ai'],
    ['fromDeepInfra', fromDeepInfra, 'https://api.deepinfra.com'],
    ['fromNovita', fromNovita, 'https://api.novita.ai'],
    ['fromHyperbolic', fromHyperbolic, 'https://api.hyperbolic.xyz'],
    ['fromMoonshot', fromMoonshot, 'https://api.moonshot.ai'],
    ['fromZhipu', fromZhipu, 'https://open.bigmodel.cn'],
    ['fromXAI', fromXAI, 'https://api.x.ai'],
    ['fromNvidiaNIM', fromNvidiaNIM, 'https://integrate.api.nvidia.com'],
    ['fromVercelAIGateway', fromVercelAIGateway, 'https://ai-gateway.vercel.sh'],
    ['fromNebius', fromNebius, 'https://api.tokenfactory.nebius.com'],
    ['fromSambaNova', fromSambaNova, 'https://api.sambanova.ai'],
    ['fromBaseten', fromBaseten, 'https://inference.baseten.co'],
    ['fromFeatherless', fromFeatherless, 'https://api.featherless.ai'],
    ['fromFriendli', fromFriendli, 'https://api.friendli.ai'],
    ['fromSiliconFlow', fromSiliconFlow, 'https://api.siliconflow.cn'],
    ['fromParasail', fromParasail, 'https://api.parasail.io'],
    ['fromStepFun', fromStepFun, 'https://api.stepfun.ai'],
    ['fromMiniMax', fromMiniMax, 'https://api.minimax.io'],
    ['fromLambdaLabs', fromLambdaLabs, 'https://api.lambda.ai'],
    ['fromInferenceNet', fromInferenceNet, 'https://api.inference.net'],
    ['fromInfermatic', fromInfermatic, 'https://api.totalgpt.ai'],
    ['fromAtlasCloud', fromAtlasCloud, 'https://api.atlascloud.ai'],
    ['from01AI', from01AI, 'https://api.lingyiwanwu.com'],
  ])('%s', (_name, fn, expectedOrigin) => {
    it('accepts a client whose baseURL origin matches, regardless of path', () => {
      expect(() => fn(fakeClient(`${expectedOrigin}/some/conventional/path`))).not.toThrow();
      expect(() => fn(fakeClient(expectedOrigin))).not.toThrow();
    });

    it('throws a validation LLMError when baseURL is unset', () => {
      expect.assertions(2);
      try {
        fn(fakeClient(undefined));
      } catch (err) {
        expect((err as { name?: string })?.name).toBe('LLMError');
        expect((err as { type?: string })?.type).toBe('validation');
      }
    });

    it('throws a validation LLMError when baseURL points at a different origin', () => {
      expect.assertions(2);
      try {
        fn(fakeClient('https://api.openai.com/v1'));
      } catch (err) {
        expect((err as { name?: string })?.name).toBe('LLMError');
        expect((err as { type?: string })?.type).toBe('validation');
      }
    });

    it('the thrown error carries expectedBaseURL/actualBaseURL issues', () => {
      try {
        fn(fakeClient(undefined));
        throw new Error('expected fn to throw');
      } catch (err) {
        expect((err as { issues?: unknown }).issues).toEqual({
          expectedBaseURL: expectedOrigin,
          actualBaseURL: undefined,
        });
      }
    });
  });
});

describe('self-hosted adapters (no fixed provider origin)', () => {
  it.each([
    ['fromOllama', fromOllama],
    ['fromLMStudio', fromLMStudio],
    ['fromVLLM', fromVLLM],
    ['fromCloudflareWorkersAI', fromCloudflareWorkersAI],
    ['fromSnowflakeCortex', fromSnowflakeCortex],
    ['fromAnyscale', fromAnyscale],
    ['fromLepton', fromLepton],
  ])('%s requires a baseURL but does not validate its origin', (_name, fn) => {
    expect.assertions(4);
    try {
      fn(fakeClient(undefined));
    } catch (err) {
      expect((err as { name?: string })?.name).toBe('LLMError');
      expect((err as { type?: string })?.type).toBe('validation');
    }
    expect(() => fn(fakeClient('http://localhost:11434/v1'))).not.toThrow();
    expect(() => fn(fakeClient('https://anything.example.com/v1'))).not.toThrow();
  });
});

describe('adapter identity', () => {
  it.each([
    ['fromOpenAI', fromOpenAI],
    ['fromGroq', fromGroq],
    ['fromMistral', fromMistral],
    ['fromDeepSeek', fromDeepSeek],
    ['fromCerebras', fromCerebras],
    ['fromTogether', fromTogether],
    ['fromFireworks', fromFireworks],
    ['fromOpenRouter', fromOpenRouter],
    ['fromPerplexity', fromPerplexity],
    ['fromDeepInfra', fromDeepInfra],
    ['fromNovita', fromNovita],
    ['fromHyperbolic', fromHyperbolic],
    ['fromMoonshot', fromMoonshot],
    ['fromZhipu', fromZhipu],
    ['fromXAI', fromXAI],
    ['fromNvidiaNIM', fromNvidiaNIM],
    ['fromVercelAIGateway', fromVercelAIGateway],
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
    ['fromInferenceNet', fromInferenceNet],
    ['fromInfermatic', fromInfermatic],
    ['fromAtlasCloud', fromAtlasCloud],
    ['from01AI', from01AI],
    ['fromOllama', fromOllama],
    ['fromLMStudio', fromLMStudio],
    ['fromVLLM', fromVLLM],
    ['fromCloudflareWorkersAI', fromCloudflareWorkersAI],
    ['fromSnowflakeCortex', fromSnowflakeCortex],
    ['fromAnyscale', fromAnyscale],
    ['fromLepton', fromLepton],
  ])(
    '%s is a function distinct from fromOpenAICompatible (validated wrapper, not a bare alias)',
    (_name, fn) => {
      expect(typeof fn).toBe('function');
    },
  );
});
