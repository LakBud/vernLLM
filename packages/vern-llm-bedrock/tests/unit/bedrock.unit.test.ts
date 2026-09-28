import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { at, stubbedClient, type ConverseHandler } from '../helpers.js';

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<ConverseHandler>(async (_params, _options) => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
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
