import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { at, stubbedClient, type ConverseHandler } from '../helpers.js';

/** `usage: null` builds a response that carries no usage block at all. */
function makeFakeBedrockClient(
  text: string,
  usage: Record<string, unknown> | null = { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
) {
  const converse = vi.fn<ConverseHandler>(async (_params, _options) => ({
    output: { message: { content: [{ text }] } },
    ...(usage ? { usage } : {}),
  }));

  return { client: stubbedClient({ converse }), converse };
}

describe('fromBedrock', () => {
  it('maps model to modelId and messages/system correctly', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.4,
        max_tokens: 300,
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        system: [{ text: 'be concise' }],
        inferenceConfig: { temperature: 0.4, maxTokens: 300 },
      }),
      { signal: expect.anything() },
    );
  });

  it('passes through an omitted temperature via inferenceConfig without crashing', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in (converse.mock.calls[0]![0].inferenceConfig ?? {})).toBe(false);
  });

  it('translates ContentBlock[] userContent into Converse image/text blocks, decoding base64 to bytes', async () => {
    const { client, converse } = makeFakeBedrockClient('described');
    const adapted = fromBedrock(client);
    const base64 = 'ZmFrZWJhc2U2NA==';

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "what's in this image?" },
              { type: 'image', data: base64, mimeType: 'image/png' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];
    const content = sentParams.messages![0]!.content!;

    expect(content[0]).toEqual({ text: "what's in this image?" });
    expect(content[1]).toMatchObject({ image: { format: 'png' } });

    const imageBlock = content[1] as { image: { format: string; source: { bytes: Uint8Array } } };
    expect(Array.from(imageBlock.image.source.bytes)).toEqual(
      Array.from(Buffer.from(base64, 'base64')),
    );
  });

  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
  ] as const)('maps %s to Converse image format %s', async (mimeType, format) => {
    const { client, converse } = makeFakeBedrockClient('described');
    const adapted = fromBedrock(client);
    const base64 = 'ZmFrZWJhc2U2NA==';

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', data: base64, mimeType }],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];
    const content = sentParams.messages![0]!.content!;
    expect(content[0]).toMatchObject({ image: { format } });
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
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

  it('throws an invalid_params LLMError for image data that is not base64', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');

    await expect(
      fromBedrock(client).chat.completions.create(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', data: 'not base64 !!', mimeType: 'image/png' }],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('decodes an image larger than one base64 chunk byte for byte', async () => {
    const { client, converse } = makeFakeBedrockClient('described');
    const original = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256);

    await fromBedrock(client).chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                data: Buffer.from(original).toString('base64'),
                mimeType: 'image/png',
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const content = at(converse.mock.calls, 0)[0].messages![0]!.content!;
    const sent = (content[0] as { image: { source: { bytes: Uint8Array } } }).image.source.bytes;

    expect(Buffer.compare(Buffer.from(sent), Buffer.from(original))).toBe(0);
  });

  it('maps output.message.content back into choices[0].message.content', async () => {
    const { client } = makeFakeBedrockClient('bedrock response');
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('bedrock response');
  });

  it('maps usage fields', async () => {
    const { client } = makeFakeBedrockClient('x');
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      prompt_tokens_details: {},
    });
  });

  describe('cache usage', () => {
    const run = async (usage: Record<string, unknown> | null) => {
      const { client } = makeFakeBedrockClient('x', usage);

      return fromBedrock(client).chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );
    };

    it('folds cache reads and writes into prompt_tokens and keeps the reported total', async () => {
      const result = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 6210,
        cacheReadInputTokens: 5000,
        cacheWriteInputTokens: 1200,
      });

      // With caching on, prompt plus completion now agrees with Bedrock's own total.
      expect(result.usage).toEqual({
        prompt_tokens: 6208,
        completion_tokens: 2,
        total_tokens: 6210,
        prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 1200 },
      });
    });

    it('reports cache writes by TTL from cacheDetails', async () => {
      const result = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 2010,
        cacheWriteInputTokens: 2000,
        cacheDetails: [
          { ttl: '5m', inputTokens: 1200 },
          { ttl: '1h', inputTokens: 800 },
        ],
      });

      expect(result.usage?.prompt_tokens_details).toEqual({
        cache_write_tokens: 2000,
        cache_write_tokens_by_ttl: { '5m': 1200, '1h': 800 },
      });
    });

    it('counts a TTL entry without inputTokens as 0, and skips one without a TTL', async () => {
      const result = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cacheDetails: [{ ttl: '5m' }, { inputTokens: 40 }],
      });

      expect(result.usage?.prompt_tokens_details?.cache_write_tokens_by_ttl).toEqual({ '5m': 0 });
    });

    it('omits the TTL split when cacheDetails is empty or has no usable entry', async () => {
      const empty = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cacheDetails: [],
      });
      const unlabeled = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cacheDetails: [{ inputTokens: 40 }],
      });

      expect(empty.usage?.prompt_tokens_details).not.toHaveProperty('cache_write_tokens_by_ttl');
      expect(unlabeled.usage?.prompt_tokens_details).not.toHaveProperty(
        'cache_write_tokens_by_ttl',
      );
    });

    it('handles reads without writes, and writes without reads', async () => {
      const reads = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 510,
        cacheReadInputTokens: 500,
      });
      const writes = await run({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 310,
        cacheWriteInputTokens: 300,
      });

      expect(reads.usage?.prompt_tokens).toBe(508);
      expect(writes.usage?.prompt_tokens).toBe(308);
    });

    it('leaves prompt_tokens undefined when inputTokens is missing, rather than reporting the cache counts alone', async () => {
      const result = await run({ outputTokens: 2, totalTokens: 502, cacheReadInputTokens: 500 });

      expect(result.usage?.prompt_tokens).toBeUndefined();
      expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(500);
    });

    it('reports nothing for a response without usage', async () => {
      const result = await run(null);

      expect(result.usage?.prompt_tokens).toBeUndefined();
      expect(result.usage?.total_tokens).toBeUndefined();
      expect(result.usage?.prompt_tokens_details?.cached_tokens).toBeUndefined();
    });
  });

  it('leaves system undefined when there is no system message and no JSON mode', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(at(converse.mock.calls, 0)[0].system).toBeUndefined();
  });

  it('preserves assistant turns and ordering for multi-turn conversations', async () => {
    const { client, converse } = makeFakeBedrockClient('About 2.1 million.');
    const adapted = fromBedrock(client);

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

    expect(at(converse.mock.calls, 0)[0].messages).toEqual([
      { role: 'user', content: [{ text: "What's the capital of France?" }] },
      { role: 'assistant', content: [{ text: 'Paris.' }] },
      { role: 'user', content: [{ text: "What's its population?" }] },
    ]);
  });

  it('defaults a plain assistant/user message with no content at all to an empty text block', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'assistant' } as unknown as { role: 'assistant'; content: string }],
      },
      { signal: new AbortController().signal },
    );

    expect(at(converse.mock.calls, 0)[0].messages).toEqual([
      { role: 'assistant', content: [{ text: '' }] },
    ]);
  });
});

describe('fromBedrock, stop reason', () => {
  const request = {
    model: 'anthropic.claude',
    max_tokens: 10,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it.each([
    ['max_tokens', 'length'],
    ['end_turn', undefined],
  ])('maps stopReason %s to finish_reason %s', async (stopReason, expected) => {
    const converse = vi.fn<ConverseHandler>(async () => ({
      output: { message: { content: [{ text: 'x' }] } },
      stopReason,
    }));

    const result = await fromBedrock(stubbedClient({ converse })).chat.completions.create(request, {
      signal: new AbortController().signal,
    });

    expect(result.choices?.[0]?.finish_reason).toBe(expected);
  });
});
