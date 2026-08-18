import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { fromAnthropic, type AnthropicClient } from '../../../../src/adapters/anthropic.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { at, makeFakeAnthropicClient } from '../../../helpers.js';

describe('Anthropic adapter integration', () => {
  it('maps Anthropic messages API into LLMClient format', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: '{"answer":"ok"}',
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
          },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: 'Return JSON',
          },
          {
            role: 'user',
            content: 'hello',
          },
        ],
      },
      {
        signal: new AbortController().signal,
      },
    );

    expect(result.choices?.[0]?.message?.content).toBe('{"answer":"ok"}');

    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 100,
        system: expect.stringContaining('JSON'),
      }),
      expect.anything(),
    );
  });

  it('sends prior assistant turns through instead of dropping them', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'About 2.1 million.' }],
          usage: { input_tokens: 20, output_tokens: 6 },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      }),
      expect.anything(),
    );
  });

  it('forces tool-use for json_schema structured output instead of prompt injection', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'tool_use', name: 'Summary', input: { ok: true } }],
          usage: { input_tokens: 14, output_tokens: 4 },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 100,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Summary', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ ok: true }));

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'Summary' })],
        tool_choice: { type: 'tool', name: 'Summary' },
      }),
      expect.anything(),
    );
  });

  it('omits provider system field when VernLLM is called without systemPrompt', async () => {
    const { client, create } = makeFakeAnthropicClient('ok');

    const llm = new VernLLM({
      client: fromAnthropic(client),
      model: 'claude-test',
    });

    const result = await llm.call({
      userContent: 'hello',
      jsonMode: false,
    });

    expect(result).toBe('ok');

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(sentParams.system).toBeUndefined();
  });

  it('passes multimodal user content through VernLLM into Anthropic image/text blocks', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'I see an image.' }],
          usage: { input_tokens: 20, output_tokens: 5 },
        })),
      },
    };

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-test',
    });

    const result = await llm.call({
      userContent: [
        { type: 'text', text: "What's in this image?" },
        { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
      ],
      jsonMode: false,
    });

    expect(result).toBe('I see an image.');

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "What's in this image?" },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'ZmFrZWJhc2U2NA==',
                },
              },
            ],
          },
        ],
      }),
      expect.anything(),
    );
  });

  describe('json_object downgrade: a plain call (no jsonMode, no jsonSchema, no tools) still works on Anthropic', () => {
    it('default jsonMode is silently downgraded to plain text, not sent as json_object and not thrown', async () => {
      const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
        content: [{ type: 'text', text: 'plain answer, not JSON' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }));

      const llm = new VernLLM({
        client: fromAnthropic({ messages: { create } }),
        model: 'claude-x',
      });

      const result = await llm.call<string>({ userContent: 'hi' });

      expect(result).toBe('plain answer, not JSON');
      // No response_format was sent at all: the client can't honor
      // json_object, so RequestBuilder never asks for it.
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty('response_format');
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty('output_config');
    });

    it('an *explicit* jsonMode: true throws a clear invalid_params error instead of silently downgrading', async () => {
      const create = vi.fn();

      const llm = new VernLLM({
        client: fromAnthropic({ messages: { create } } as never),
        model: 'claude-x',
      });

      await expect(llm.call({ userContent: 'hi', jsonMode: true })).rejects.toMatchObject({
        name: 'LLMError',
        type: 'invalid_params',
        message: expect.stringMatching(/jsonMode: true.*does not support/i),
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('jsonSchema still works normally, unaffected by the downgrade (real constraint, not json_object)', async () => {
      const create = vi.fn(async () => ({
        content: [{ type: 'tool_use', id: 't1', name: 'answer', input: { ok: true } }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }));

      const llm = new VernLLM({
        client: fromAnthropic({ messages: { create } } as never),
        model: 'claude-x',
      });

      const result = await llm.call<{ ok: boolean }>({
        userContent: 'hi',
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
      });

      expect(result).toEqual({ ok: true });
    });

    it('`schema` without `jsonSchema` still requires JSON parsing and throws if jsonMode: false is also set, same as before', async () => {
      const create = vi.fn();

      const llm = new VernLLM({
        client: fromAnthropic({ messages: { create } } as never),
        model: 'claude-x',
      });

      await expect(
        llm.call({ userContent: 'hi', jsonMode: false, schema: z.object({}) }),
      ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });
    });
  });
});
