import { describe, it, expect, vi } from 'vitest';

import { fromAnthropic } from '../../../src/adapters/anthropic.js';
import { at } from '../../helpers.js';

function makeFakeAnthropicClient(
  responseText: string,
  usage = { input_tokens: 10, output_tokens: 5 },
) {
  const create = vi.fn(
    async (
      _params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      },
      _options: { signal: AbortSignal },
    ) => ({
      content: [{ type: 'text', text: responseText }],
      usage,
    }),
  );

  return { client: { messages: { create } }, create };
}

describe('fromAnthropic', () => {
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
    });
  });

  it('appends a JSON instruction to the system prompt when json_object mode is requested', async () => {
    const { client, create } = makeFakeAnthropicClient('{}');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentSystem = at(create.mock.calls, 0)[0].system as string;
    expect(sentSystem).toMatch(/valid JSON only/i);
  });

  it('embeds the schema in the system prompt for json_schema mode', async () => {
    const { client, create } = makeFakeAnthropicClient('{}');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentSystem = at(create.mock.calls, 0)[0].system as string;
    expect(sentSystem).toContain('Candidate');
    expect(sentSystem).toContain('"type":"object"');
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
});
