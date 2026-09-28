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

/** A fake client that responds with a forced toolUse block instead of text. */
function makeFakeBedrockToolClient(toolName: string, input: unknown) {
  const converse = vi.fn<ConverseHandler>(async (_params, _options) => ({
    output: { message: { content: [{ toolUse: { name: toolName, input } }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: stubbedClient({ converse }), converse };
}

describe('fromBedrock, native structured output', () => {
  const nativeModel = 'anthropic.claude-native-model';

  it('never uses the native path by default, so `tools` + `jsonSchema` is still rejected with no nativeStructuredOutputModels configured', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: nativeModel,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'tools_with_json_schema' },
      message: expect.stringContaining(nativeModel),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('throws a validation LLMError naming the model when combining `tools` with `jsonSchema` on a model not covered by nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: ['some-other-model'] });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'amazon.titan-text',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'tools_with_json_schema' },
      message: expect.stringContaining('amazon.titan-text'),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('sends jsonSchema as outputConfig.textFormat alongside real tools, unmodified, on a model covered by nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Out',
            schema: { type: 'object' },
            description: 'desc',
            strict: true,
          },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'get_weather',
            description: 'weather',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
      toolChoice: { auto: {} },
    });

    // Nested under structure.jsonSchema, schema JSON-encoded as a string,
    // matching the real Bedrock Converse API exactly; no strict field.
    expect(sentParams.outputConfig).toEqual({
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: {
            schema: JSON.stringify({ type: 'object' }),
            name: 'Out',
            description: 'desc',
          },
        },
      },
    });

    expect(result.choices?.[0]?.message?.content).toBe('{"ok":true}');
  });

  it('sends jsonSchema alone as outputConfig.textFormat (not a forced tool call) on a covered model, even with no real tools present', async () => {
    const { client, converse } = makeFakeBedrockClient('{"name":"Ada"}');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toBeUndefined();
    expect(sentParams.outputConfig).toEqual({
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: { schema: JSON.stringify({ type: 'object' }), name: 'Candidate' },
        },
      },
    });
    expect(result.choices?.[0]?.message?.content).toBe('{"name":"Ada"}');
  });

  it('still uses the legacy forced-tool-call path for jsonSchema alone on a non-covered model (regression)', async () => {
    const { client, converse } = makeFakeBedrockToolClient('Candidate', { name: 'Ada' });
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'amazon.titan-text',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Candidate',
            description: undefined,
            inputSchema: { json: { type: 'object' } },
            strict: undefined,
          },
        },
      ],
      toolChoice: { tool: { name: 'Candidate' } },
    });
    expect(sentParams.outputConfig).toBeUndefined();
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('supports a predicate function instead of a static list for nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: (model) => model.startsWith('anthropic.claude-native-'),
    });

    await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Out', schema: { type: 'object' } },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.outputConfig).toBeDefined();
    expect(sentParams.toolConfig?.tools).toEqual([
      {
        toolSpec: {
          name: 'get_weather',
          description: 'weather',
          inputSchema: { json: { type: 'object' } },
        },
      },
    ]);
  });

  it('tools alone still work unmodified on a nativeStructuredOutputModels-covered model (regression)', async () => {
    const { client, converse } = makeFakeBedrockToolClient('get_weather', { city: 'NYC' });
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.outputConfig).toBeUndefined();
    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: expect.any(String),
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  it("this adapter's toolUseSupportedModels preflight still runs independently for legacy jsonSchema calls, unaffected by nativeStructuredOutputModels", async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, { toolUseSupportedModels: ['supported-model'] });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'unsupported-model',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('toolUseSupportedModels preflight also runs on the native path when real tools are sent alongside outputConfig (closes the gap where native structured output skipped it)', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: [nativeModel],
      toolUseSupportedModels: ['some-other-model'],
    });

    await expect(
      adapted.chat.completions.create(
        {
          model: nativeModel,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('toolUseSupportedModels preflight does not run on the native path when no real tools are sent (native structured output alone needs no tool-use support)', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: [nativeModel],
      toolUseSupportedModels: ['some-other-model'],
    });

    await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Out', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse).toHaveBeenCalledOnce();
  });

  it(
    'streams a native model correctly with real tools present: outputConfig is sent, text ' +
      'surfaces as text-delta, and the concurrent real tool call surfaces as tool_call_delta',
    async () => {
      // Small local streaming fake, matching bedrock.stream.unit.test.ts's
      // fakeBedrockStream/makeFakeStreamingBedrockClient shape, kept local
      // here since this is the only streaming test in this file (every
      // other streaming case lives in bedrock.stream.unit.test.ts; this
      // one belongs alongside the other native-structured-output cases
      // instead, since it's specifically about the interaction between
      // `nativeStructuredOutputModels` and `createStream`, not streaming
      // mechanics in general).
      function fakeStream(events: unknown[]): AsyncIterable<unknown> {
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                if (index >= events.length) return { done: true, value: undefined };
                return { done: false, value: events[index++] };
              },
            };
          },
        };
      }

      const converse = vi.fn<ConverseHandler>(async () => ({}));
      const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
        stream: fakeStream([
          { contentBlockStart: { contentBlockIndex: 0, start: {} } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"ok":true}' } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'call_1', name: 'get_weather' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 1,
              delta: { toolUse: { input: '{"city":"NYC"}' } },
            },
          },
          { contentBlockStop: { contentBlockIndex: 1 } },
          { metadata: { usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } } },
        ]),
      }));

      const adapted = fromBedrock(stubbedClient({ converse, converseStream }), {
        nativeStructuredOutputModels: [nativeModel],
      });

      const chunks: unknown[] = [];
      for await (const chunk of adapted.chat.completions.createStream!(
        {
          model: nativeModel,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      )) {
        chunks.push(chunk);
      }

      const [sentParams] = converseStream.mock.calls[0] as unknown as [
        Record<string, unknown>,
        unknown,
      ];
      expect(sentParams.outputConfig).toEqual({
        textFormat: {
          type: 'json_schema',
          structure: { jsonSchema: { schema: JSON.stringify({ type: 'object' }), name: 'Out' } },
        },
      });

      expect(chunks).toEqual([
        { type: 'text-delta', delta: '{"ok":true}' },
        { type: 'tool_call_delta', index: 1, id: 'call_1', name: 'get_weather' },
        { type: 'tool_call_delta', index: 1, argumentsDelta: '{"city":"NYC"}' },
        { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
      ]);
    },
  );

  describe('thinking + forced tool_choice (Claude models)', () => {
    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a forced single-tool choice', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'anthropic.claude-test',
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

      expect(converse).not.toHaveBeenCalled();
    });

    it('throws invalid_params when reasoning_effort is set alongside tool_choice: "required"', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'anthropic.claude-test',
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

      expect(converse).not.toHaveBeenCalled();
    });

    it('does not throw, and sends thinking, when tool_choice is left at auto', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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

      const [sentParams] = at(converse.mock.calls, 0) as unknown as [
        Record<string, unknown>,
        unknown,
      ];
      expect(sentParams.additionalModelRequestFields).toEqual({
        thinking: { type: 'enabled', budget_tokens: 1024 },
      });
    });

    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a non-native response_format jsonSchema (implicit forced tool)', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'anthropic.claude-test',
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

      expect(converse).not.toHaveBeenCalled();
    });

    it('is unaffected on a non-Claude model (thinking never applies there in the first place)', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'eu.amazon.nova-lite-v1:0',
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
      );

      expect(converse).toHaveBeenCalledOnce();
    });
  });
});
