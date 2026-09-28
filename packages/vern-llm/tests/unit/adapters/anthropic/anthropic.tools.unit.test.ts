import { describe, it, expect, vi } from 'vitest';

import { type AnthropicClient, fromAnthropic } from '../../../../src/adapters/index.js';
import { at, makeFakeAnthropicClient } from '../../../helpers.js';

describe('fromAnthropic, tools', () => {
  it('throws a validation LLMError when a real tool\'s parameters schema is missing "type": "object"', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Gets the weather for a city',
                // Missing `type: 'object'`.
                parameters: { properties: { city: { type: 'string' } } },
              },
            },
          ],
          messages: [{ role: 'user', content: 'weather?' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
  });

  it('defaults a text block with no text field to an empty string, and a tool_use block with no input to an empty object', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text' }, { type: 'tool_use', id: 'call_1', name: 'get_weather' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic({ messages: { create } });

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
          },
        ],
        messages: [{ role: 'user', content: 'weather?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('');
    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{}' },
      },
    ]);
  });

  it('handles parallel tool_use responses and continuation requests with merged tool_result blocks', async () => {
    const create = vi
      .fn<AnthropicClient['messages']['create']>()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'call_weather',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'call_time',
            name: 'time',
            input: { city: 'Paris' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Sunny, 15:00.' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      });

    const adapted = fromAnthropic({
      messages: { create },
    });

    const first = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 100,
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              description: 'Gets weather',
              parameters: { type: 'object' },
            },
          },
          {
            type: 'function',
            function: {
              name: 'time',
              description: 'Gets time',
              parameters: { type: 'object' },
            },
          },
        ],
        messages: [{ role: 'user', content: 'Weather and time in Paris?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(first.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_weather',
        type: 'function',
        function: {
          name: 'weather',
          arguments: JSON.stringify({ city: 'Paris' }),
        },
      },
      {
        id: 'call_time',
        type: 'function',
        function: {
          name: 'time',
          arguments: JSON.stringify({ city: 'Paris' }),
        },
      },
    ]);

    expect(at(create.mock.calls, 0)[0]).toMatchObject({
      tools: [
        {
          name: 'weather',
          description: 'Gets weather',
          input_schema: { type: 'object' },
        },
        {
          name: 'time',
          description: 'Gets time',
          input_schema: { type: 'object' },
        },
      ],
    });

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'Weather and time in Paris?' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: {
                  name: 'weather',
                  arguments: JSON.stringify({ city: 'Paris' }),
                },
              },
              {
                id: 'call_time',
                type: 'function',
                function: {
                  name: 'time',
                  arguments: JSON.stringify({ city: 'Paris' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_weather',
            content: 'Sunny',
          },
          {
            role: 'tool',
            tool_call_id: 'call_time',
            content: '15:00',
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 1)[0].messages).toEqual([
      {
        role: 'user',
        content: 'Weather and time in Paris?',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_weather',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'call_time',
            name: 'time',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_weather',
            content: 'Sunny',
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_time',
            content: '15:00',
          },
        ],
      },
    ]);
  });

  it('defaults an assistant tool_call with empty/whitespace-only arguments to an empty input object', async () => {
    const { client, create } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 10,
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '  ' },
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }],
      },
    ]);
  });

  it("throws validation when an assistant tool_call's arguments parse to a non-object (e.g. an array)", async () => {
    const { client } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 10,
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '[1,2,3]' },
                },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('arguments must be a JSON object'),
    });
  });

  it("throws validation when an assistant tool_call's arguments are not valid JSON at all", async () => {
    const { client } = makeFakeAnthropicClient('hi');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 10,
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{not valid json' },
                },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('are not valid JSON'),
    });
  });

  it('maps tool_choice: "none" to Anthropic\'s { type: "none" }', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const adapted = fromAnthropic({ messages: { create } });

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: { name: 'f', description: 'd', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'none',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].tool_choice).toEqual({ type: 'none' });
  });

  it('maps tool_choice: "required" to Anthropic\'s { type: "any" }', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const adapted = fromAnthropic({ messages: { create } });

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: { name: 'f', description: 'd', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'required',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].tool_choice).toEqual({ type: 'any' });
  });

  describe('thinking + forced tool_choice', () => {
    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a forced single-tool choice', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            budget_tokens: 1024,
            tools: [
              {
                type: 'function',
                function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
              },
            ],
            tool_choice: { type: 'function', function: { name: 'summarize' } },
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('throws invalid_params when reasoning_effort is set alongside tool_choice: "required"', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            reasoning_effort: 'low',
            tools: [
              {
                type: 'function',
                function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
              },
            ],
            tool_choice: 'required',
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('does not throw, and sends thinking, when tool_choice is left at auto', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 2000,
          budget_tokens: 1024,
          tools: [
            {
              type: 'function',
              function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
            },
          ],
          tool_choice: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sentParams = at(create.mock.calls, 0)[0];
      expect(sentParams.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a non-native response_format jsonSchema (implicit forced tool)', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            budget_tokens: 1024,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'Out', schema: { type: 'object' } },
            },
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('does not throw when budget_tokens is set with no tools/tool_choice at all', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 2000,
          budget_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create).toHaveBeenCalledOnce();
    });
  });
});

describe('fromAnthropic, merges multiple tool results into one user turn', () => {
  it('combines two consecutive tool-result wire messages into a single user message with two tool_result blocks', async () => {
    const { client, create } = makeFakeAnthropicClient('ok');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: { name: 't', description: 'd', parameters: { type: 'object' } },
          },
        ],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'result a' },
          { role: 'tool', tool_call_id: 'call_2', content: 'result b' },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentMessages = at(create.mock.calls, 0)[0].messages;

    expect(sentMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(sentMessages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'a', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result a' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'result b' },
        ],
      },
    ]);
  });
});
