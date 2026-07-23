import { describe, it, expect, vi } from 'vitest';

import { fromAnthropic } from '../../../src/adapters/index.js';
import { at, makeFakeAnthropicClient } from '../../helpers.js';

/** A fake client that responds with a forced tool_use block instead of text. */
function makeFakeAnthropicToolClient(
  toolName: string,
  input: unknown,
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
        tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
        tool_choice?: { type: 'tool'; name: string };
      },
      _options: { signal: AbortSignal },
    ) => ({
      content: [{ type: 'tool_use', name: toolName, input }],
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

  it('forces tool-use for json_schema mode instead of embedding the schema in the prompt', async () => {
    const { client, create } = makeFakeAnthropicToolClient('Candidate', { name: 'Ada' });
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'm',
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

    const sentParams = at(create.mock.calls, 0)[0];

    // The schema is passed as a tool definition, not embedded in the system prompt
    expect(sentParams.system).toBeUndefined();
    expect(sentParams.tools).toEqual([
      { name: 'Candidate', description: 'A candidate', input_schema: { type: 'object' } },
    ]);
    expect(sentParams.tool_choice).toEqual({ type: 'tool', name: 'Candidate' });

    // The tool_use block's already-parsed input is re-serialized to a JSON string
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('falls back to a prompt instruction for json_object mode (no schema to build a tool from)', async () => {
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

    const sentParams = at(create.mock.calls, 0)[0] as unknown as {
      system?: string;
      tools?: unknown;
    };
    expect(sentParams.system).toMatch(/valid JSON only/i);
    expect(sentParams.tools).toBeUndefined();
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
});
