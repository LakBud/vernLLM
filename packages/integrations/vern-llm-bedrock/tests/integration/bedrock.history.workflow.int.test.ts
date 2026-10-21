import { VernLLM } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient } from '../helpers.js';

describe('VernLLM + fromBedrock: conversation history', () => {
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
      client: fromBedrock(stubbedClient(bedrock)),
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
      client: fromBedrock(stubbedClient(bedrock)),
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
