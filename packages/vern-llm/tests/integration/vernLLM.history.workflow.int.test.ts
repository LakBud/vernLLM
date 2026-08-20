import { describe, expect, it, vi } from 'vitest';

import {
  fromAnthropic,
  fromBedrock,
  fromFetch,
  fromGemini,
  fromOpenAICompatible,
} from '../../src/adapters/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { at } from '../helpers.js';

describe('VernLLM + adapter integration: conversation history', () => {
  describe('OpenAI-compatible', () => {
    it('serializes structured assistant history content, including null, through the adapter', async () => {
      const openai = {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            })),
          },
        },
      };

      const llm = new VernLLM({
        client: fromOpenAICompatible(openai),
        model: 'openai-compatible-test',
      });

      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'give me json' },
          { role: 'assistant', content: { name: 'Ada', skills: ['ts'] } },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: null },
        ],
      });

      expect(openai.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'give me json' },
            {
              role: 'assistant',
              content: JSON.stringify({ name: 'Ada', skills: ['ts'] }),
            },
            { role: 'user', content: 'and now nothing' },
            { role: 'assistant', content: JSON.stringify(null) },
            { role: 'user', content: 'continue' },
          ],
        }),
        expect.anything(),
      );
    });

    it('preserves both content and toolCalls on an assistant history turn through the adapter', async () => {
      const openai = {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{ message: { content: 'Sounds good.' } }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            })),
          },
        },
      };

      const llm = new VernLLM({
        client: fromOpenAICompatible(openai),
        model: 'openai-compatible-test',
      });

      await llm.call({
        userContent: 'thanks',
        jsonMode: false,
        history: [
          { role: 'user', content: "What's the weather in Paris?" },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_weather',
                arguments: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            toolResults: [{ toolCallId: 'call_1', content: 'sunny' }],
          },
          { role: 'assistant', content: "It's sunny in Paris." },
        ],
      });

      expect(openai.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: "What's the weather in Paris?" },
            {
              role: 'assistant',
              content: 'Let me check the weather.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ city: 'Paris' }),
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              content: 'sunny',
            },
            { role: 'assistant', content: "It's sunny in Paris." },
            { role: 'user', content: 'thanks' },
          ],
        }),
        expect.anything(),
      );
    });
  });

  describe('Anthropic', () => {
    it('serializes structured assistant history content, including null, through the adapter', async () => {
      const anthropic = {
        messages: {
          create: vi.fn(async () => ({
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
            },
          })),
        },
      };

      const llm = new VernLLM({
        client: fromAnthropic(anthropic),
        model: 'anthropic-test',
      });

      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'give me json' },
          { role: 'assistant', content: { name: 'Ada', skills: ['ts'] } },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: null },
        ],
      });

      expect(anthropic.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: 'give me json',
            },
            {
              role: 'assistant',
              content: JSON.stringify({
                name: 'Ada',
                skills: ['ts'],
              }),
            },
            {
              role: 'user',
              content: 'and now nothing',
            },
            {
              role: 'assistant',
              content: JSON.stringify(null),
            },
            {
              role: 'user',
              content: 'continue',
            },
          ],
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('preserves both content and toolCalls on an assistant history turn through the adapter', async () => {
      const anthropic = {
        messages: {
          create: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Sounds good.' }],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
            },
          })),
        },
      };

      const llm = new VernLLM({
        client: fromAnthropic(anthropic),
        model: 'anthropic-test',
      });

      await llm.call({
        userContent: 'thanks',
        jsonMode: false,
        history: [
          {
            role: 'user',
            content: "What's the weather in Paris?",
          },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_weather',
                arguments: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            toolResults: [
              {
                toolCallId: 'call_1',
                content: 'sunny',
              },
            ],
          },
          {
            role: 'assistant',
            content: "It's sunny in Paris.",
          },
        ],
      });

      expect(anthropic.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: "What's the weather in Paris?",
            },
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Let me check the weather.',
                },
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'get_weather',
                  input: {
                    city: 'Paris',
                  },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_1',
                  content: 'sunny',
                },
              ],
            },
            {
              role: 'assistant',
              content: "It's sunny in Paris.",
            },
            {
              role: 'user',
              content: 'thanks',
            },
          ],
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe('Gemini', () => {
    it('serializes structured assistant history content, including null, through the adapter', async () => {
      const gemini = {
        generateContent: vi.fn(async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'ok' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
          },
        })),
      };

      const llm = new VernLLM({
        client: fromGemini(gemini),
        model: 'gemini-test',
      });

      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'give me json' },
          {
            role: 'assistant',
            content: { name: 'Ada', skills: ['ts'] },
          },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: null },
        ],
      });

      expect(gemini.generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'give me json' }],
            },
            {
              role: 'model',
              parts: [
                {
                  text: JSON.stringify({
                    name: 'Ada',
                    skills: ['ts'],
                  }),
                },
              ],
            },
            {
              role: 'user',
              parts: [{ text: 'and now nothing' }],
            },
            {
              role: 'model',
              parts: [{ text: JSON.stringify(null) }],
            },
            {
              role: 'user',
              parts: [{ text: 'continue' }],
            },
          ],
        }),
      );
    });

    it('preserves both content and toolCalls on an assistant history turn through the adapter', async () => {
      const gemini = {
        generateContent: vi.fn(async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Sounds good.' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
          },
        })),
      };

      const llm = new VernLLM({
        client: fromGemini(gemini),
        model: 'gemini-test',
      });

      await llm.call({
        userContent: 'thanks',
        jsonMode: false,
        history: [
          {
            role: 'user',
            content: "What's the weather in Paris?",
          },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_weather',
                arguments: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            toolResults: [
              {
                toolCallId: 'call_1',
                content: 'sunny',
              },
            ],
          },
          {
            role: 'assistant',
            content: "It's sunny in Paris.",
          },
        ],
      });

      expect(gemini.generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: "What's the weather in Paris?",
                },
              ],
            },
            {
              role: 'model',
              parts: [
                {
                  text: 'Let me check the weather.',
                },
                {
                  functionCall: {
                    name: 'get_weather',
                    args: {
                      city: 'Paris',
                    },
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'call_1',
                    response: 'sunny',
                  },
                },
              ],
            },
            {
              role: 'model',
              parts: [
                {
                  text: "It's sunny in Paris.",
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  text: 'thanks',
                },
              ],
            },
          ],
        }),
      );
    });
  });

  describe('Bedrock', () => {
    it('serializes structured assistant history content, including null, through the adapter', async () => {
      const bedrock = {
        converse: vi.fn(async () => ({
          output: {
            message: {
              content: [{ text: 'ok' }],
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 2,
          },
        })),
      };

      const llm = new VernLLM({
        client: fromBedrock(bedrock),
        model: 'bedrock-test',
      });

      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'give me json' },
          { role: 'assistant', content: { name: 'Ada', skills: ['ts'] } },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: null },
        ],
      });

      expect(bedrock.converse).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'bedrock-test',
          messages: [
            {
              role: 'user',
              content: [{ text: 'give me json' }],
            },
            {
              role: 'assistant',
              content: [
                {
                  text: JSON.stringify({ name: 'Ada', skills: ['ts'] }),
                },
              ],
            },
            {
              role: 'user',
              content: [{ text: 'and now nothing' }],
            },
            {
              role: 'assistant',
              content: [{ text: JSON.stringify(null) }],
            },
            {
              role: 'user',
              content: [{ text: 'continue' }],
            },
          ],
        }),
        expect.anything(),
      );
    });

    it('preserves both content and toolCalls on an assistant history turn through the adapter', async () => {
      const bedrock = {
        converse: vi.fn(async () => ({
          output: {
            message: {
              content: [{ text: 'Sounds good.' }],
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 2,
          },
        })),
      };

      const llm = new VernLLM({
        client: fromBedrock(bedrock),
        model: 'bedrock-test',
      });

      await llm.call({
        userContent: 'thanks',
        jsonMode: false,
        history: [
          { role: 'user', content: "What's the weather in Paris?" },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_weather',
                arguments: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            toolResults: [{ toolCallId: 'call_1', content: 'sunny' }],
          },
          { role: 'assistant', content: "It's sunny in Paris." },
        ],
      });

      expect(bedrock.converse).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ text: "What's the weather in Paris?" }],
            },
            {
              role: 'assistant',
              content: [
                { text: 'Let me check the weather.' },
                {
                  toolUse: {
                    toolUseId: 'call_1',
                    name: 'get_weather',
                    input: { city: 'Paris' },
                  },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'call_1',
                    content: [{ text: 'sunny' }],
                    status: 'success',
                  },
                },
              ],
            },
            {
              role: 'assistant',
              content: [{ text: "It's sunny in Paris." }],
            },
            {
              role: 'user',
              content: [{ text: 'thanks' }],
            },
          ],
        }),
        expect.anything(),
      );
    });
  });

  describe('Fetch', () => {
    it('passes structured assistant history content, including null, to mapRequest', async () => {
      const request = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: vi.fn(() => null),
        },
        json: async () => ({
          content: 'ok',
        }),
        text: async () => '',
      }));

      const mapRequest = vi.fn((params) => params);

      const llm = new VernLLM({
        client: fromFetch({
          url: 'https://example.test/v1/chat',
          request,
          mapRequest,
          mapResponse: () => ({
            content: 'ok',
          }),
        }),
        model: 'fetch-test',
      });

      await llm.call({
        userContent: 'continue',
        jsonMode: false,
        history: [
          { role: 'user', content: 'give me json' },
          { role: 'assistant', content: { name: 'Ada', skills: ['ts'] } },
          { role: 'user', content: 'and now nothing' },
          { role: 'assistant', content: null },
        ],
      });

      expect(mapRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'give me json' },
            {
              role: 'assistant',
              content: JSON.stringify({ name: 'Ada', skills: ['ts'] }),
            },
            { role: 'user', content: 'and now nothing' },
            { role: 'assistant', content: JSON.stringify(null) },
            { role: 'user', content: 'continue' },
          ],
        }),
      );

      expect(request).toHaveBeenCalledWith(
        'https://example.test/v1/chat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(at(mapRequest.mock.calls, 0)[0]),
        }),
      );
    });

    it('preserves both content and toolCalls on an assistant history turn through the adapter', async () => {
      const request = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: vi.fn(() => null),
        },
        json: async () => ({
          content: 'Sounds good.',
        }),
        text: async () => '',
      }));

      const mapRequest = vi.fn((params) => params);

      const llm = new VernLLM({
        client: fromFetch({
          url: 'https://example.test/v1/chat',
          request,
          mapRequest,
          mapResponse: () => ({
            content: 'Sounds good.',
          }),
        }),
        model: 'fetch-test',
      });

      await llm.call({
        userContent: 'thanks',
        jsonMode: false,
        history: [
          { role: 'user', content: "What's the weather in Paris?" },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'get_weather',
                arguments: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            toolResults: [{ toolCallId: 'call_1', content: 'sunny' }],
          },
          { role: 'assistant', content: "It's sunny in Paris." },
        ],
      });

      expect(mapRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: "What's the weather in Paris?",
            },
            {
              role: 'assistant',
              content: 'Let me check the weather.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ city: 'Paris' }),
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              content: 'sunny',
            },
            {
              role: 'assistant',
              content: "It's sunny in Paris.",
            },
            {
              role: 'user',
              content: 'thanks',
            },
          ],
        }),
      );
    });
  });
});
