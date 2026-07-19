import { describe, it, expect, vi } from 'vitest';

import { type BedrockConverseClient, fromBedrock } from '../../../src/adapters/bedrock.js';
import { at } from '../../helpers.js';

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async (_params, _options) => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: { converse }, converse };
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

  it('emulates JSON mode via a system-prompt instruction, appended to any existing system message', async () => {
    const { client, converse } = makeFakeBedrockClient('{}');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
      },
      { signal: new AbortController().signal },
    );

    const system = at(converse.mock.calls, 0)[0].system as Array<{ text: string }>;
    expect(at(system, 0).text).toBe('be brief');
    expect(at(system, 1).text).toMatch(/valid JSON only/i);
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
});
