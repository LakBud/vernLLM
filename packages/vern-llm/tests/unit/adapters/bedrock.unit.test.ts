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

/** A fake client that responds with a forced toolUse block instead of text. */
function makeFakeBedrockToolClient(toolName: string, input: unknown) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async (_params, _options) => ({
    output: { message: { content: [{ toolUse: { name: toolName, input } }] } },
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

  it('forces tool-use via toolConfig for json_schema mode instead of a prompt instruction', async () => {
    const { client, converse } = makeFakeBedrockToolClient('Candidate', { name: 'Ada' });
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Candidate',
            schema: { type: 'object' },
            description: 'A candidate',
          },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.system).toBeUndefined();
    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Candidate',
            description: 'A candidate',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
      toolChoice: { tool: { name: 'Candidate' } },
    });

    // The toolUse block's already-parsed input is re-serialized to a JSON string
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
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
});
