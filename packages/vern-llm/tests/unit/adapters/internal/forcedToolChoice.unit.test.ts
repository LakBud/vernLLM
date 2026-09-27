import { describe, expect, it, vi } from 'vitest';

import {
  fromAnthropic,
  fromBedrock,
  type AnthropicClient,
  type BedrockConverseClient,
} from '../../../../src/adapters/index.js';
import { rejectsForcedToolChoice } from '../../../../src/adapters/internal/forcedToolChoice.js';
import { LLMError, VernLLM } from '../../../../src/index.js';

import type { LLMClient } from '../../../../src/types/index.js';

type Request = Parameters<LLMClient['chat']['completions']['create']>[0];

const signal = new AbortController().signal;

const tools: Request['tools'] = [
  {
    type: 'function',
    function: { name: 'lookup', description: 'Looks up', parameters: { type: 'object' } },
  },
];

const jsonSchema: NonNullable<Request['response_format']> = {
  type: 'json_schema',
  json_schema: { name: 'answer', schema: { type: 'object', properties: {} } },
};

function request(model: string, extra: Partial<Request> = {}): Request {
  return { model, max_tokens: 2000, messages: [{ role: 'user', content: 'hi' }], ...extra };
}

describe('rejectsForcedToolChoice, built in rule', () => {
  it.each([
    ['claude-opus-5-4', false],
    ['claude-opus-5-5', true],
    ['claude-opus-5-6-20270101', true],
    ['claude-opus-5-20260101', false],
    ['claude-fable-5', false],
    ['claude-fable-5-0', false],
    ['claude-fable-5-1', true],
    ['claude-fable-5.2', true],
    ['claude-sonnet-5', false],
    ['claude-sonnet-5-9', false],
    ['claude-haiku-4-5-20251001', false],
    ['claude-sonnet-6', true],
    ['claude-haiku-6-0', true],
    ['claude-3-5-sonnet-20241022', false],
    ['claude-6-sonnet', true],
    ['gpt-6', false],
  ])('%s -> %s', (model, expected) => {
    expect(rejectsForcedToolChoice(model)).toBe(expected);
  });

  it.each([
    ['anthropic.claude-opus-5-5-20260101-v1:0', true],
    ['us.anthropic.claude-fable-5-1-v1:0', true],
    ['eu.anthropic.claude-opus-5-4-v1:0', false],
    ['arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-6-v1:0', true],
    ['anthropic.claude-sonnet-5-v1:0', false],
  ])('matches the Bedrock id %s -> %s', (model, expected) => {
    expect(rejectsForcedToolChoice(model)).toBe(expected);
  });
});

describe('rejectsForcedToolChoice, override', () => {
  it('replaces the built in rule with a list, in both directions', () => {
    const override = ['claude-sonnet-5'];

    expect(rejectsForcedToolChoice('claude-sonnet-5', override)).toBe(true);
    expect(rejectsForcedToolChoice('claude-opus-5-5', override)).toBe(false);
  });

  it('replaces the built in rule with a predicate', () => {
    const override = (model: string) => model.startsWith('custom-');

    expect(rejectsForcedToolChoice('custom-model', override)).toBe(true);
    expect(rejectsForcedToolChoice('claude-fable-5-1', override)).toBe(false);
  });
});

describe('fromAnthropic, models that reject forced tool_choice', () => {
  function client() {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    return { client: { messages: { create } } as unknown as AnthropicClient, create };
  }

  it.each([
    ['required' as const, "toolChoice: 'required'"],
    [{ type: 'function' as const, function: { name: 'lookup' } }, "toolChoice: { name: 'lookup' }"],
  ])('throws locally for %j, naming the model and the choice', async (toolChoice, described) => {
    const { client: anthropic, create } = client();

    const error = await fromAnthropic(anthropic)
      .chat.completions.create(request('claude-opus-5-5', { tools, tool_choice: toolChoice }), {
        signal,
      })
      .catch((e: unknown) => e);

    expect(create).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'forced_tool_choice' },
    });
    expect((error as LLMError).message).toContain('"claude-opus-5-5"');
    expect((error as LLMError).message).toContain(described);
  });

  it.each(['auto', 'none', undefined] as const)(
    'sends toolChoice %s unchanged',
    async (toolChoice) => {
      const { client: anthropic, create } = client();

      await fromAnthropic(anthropic).chat.completions.create(
        request('claude-fable-5-1', { tools, tool_choice: toolChoice }),
        { signal },
      );

      expect(create).toHaveBeenCalledOnce();
    },
  );

  it('still forces a tool on a model below the thresholds', async () => {
    const { client: anthropic, create } = client();

    await fromAnthropic(anthropic).chat.completions.create(
      request('claude-opus-5-4', { tools, tool_choice: 'required' }),
      { signal },
    );

    expect((create.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      tool_choice: { type: 'any' },
    });
  });

  it('uses native structured output for jsonSchema without nativeStructuredOutputModels', async () => {
    const { client: anthropic, create } = client();

    await fromAnthropic(anthropic).chat.completions.create(
      request('claude-opus-5-5', { response_format: jsonSchema }),
      { signal },
    );

    const body = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object', properties: {} } },
    });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('sends real tools alongside native structured output', async () => {
    const { client: anthropic, create } = client();

    await fromAnthropic(anthropic).chat.completions.create(
      request('claude-fable-5-1', { response_format: jsonSchema, tools }),
      { signal },
    );

    const body = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body.output_config).toBeDefined();
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools).toEqual([
      expect.objectContaining({ name: 'lookup', input_schema: { type: 'object' } }),
    ]);
  });

  it('falls back to the forced tool emulation once the override excludes the model', async () => {
    const { client: anthropic, create } = client();
    create.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't', name: 'answer', input: {} }],
    } as never);

    await fromAnthropic(anthropic, {
      forcedToolChoiceUnsupportedModels: [],
    }).chat.completions.create(request('claude-opus-5-5', { response_format: jsonSchema }), {
      signal,
    });

    expect((create.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      tool_choice: { type: 'tool', name: 'answer' },
    });
  });
});

describe('fromBedrock, models that reject forced tool_choice', () => {
  function client() {
    const converse = vi.fn(async () => ({ output: { message: { content: [{ text: '{}' }] } } }));
    return { client: { converse } as unknown as BedrockConverseClient, converse };
  }

  it('throws locally for a forced choice on a region prefixed profile id', async () => {
    const { client: bedrock, converse } = client();

    const error = await fromBedrock(bedrock)
      .chat.completions.create(
        request('us.anthropic.claude-opus-5-5-v1:0', { tools, tool_choice: 'required' }),
        { signal },
      )
      .catch((e: unknown) => e);

    expect(converse).not.toHaveBeenCalled();
    expect(error).toMatchObject({ type: 'invalid_params', code: 'unsupported_capability' });
    expect((error as LLMError).message).toContain(
      'Bedrock model "us.anthropic.claude-opus-5-5-v1:0"',
    );
  });

  it('uses outputConfig for jsonSchema without nativeStructuredOutputModels', async () => {
    const { client: bedrock, converse } = client();

    await fromBedrock(bedrock).chat.completions.create(
      request('anthropic.claude-fable-5-1-v1:0', { response_format: jsonSchema }),
      { signal },
    );

    const sent = (converse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(sent.outputConfig).toBeDefined();
    expect(sent).not.toHaveProperty('toolConfig');
  });

  it('keeps real tools with auto choice next to outputConfig', async () => {
    const { client: bedrock, converse } = client();

    await fromBedrock(bedrock).chat.completions.create(
      request('anthropic.claude-fable-5-1-v1:0', { response_format: jsonSchema, tools }),
      { signal },
    );

    const sent = (converse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(sent.outputConfig).toBeDefined();
    expect(sent.toolConfig).toMatchObject({ toolChoice: { auto: {} } });
  });

  it('lets the override take a model out of the rule', async () => {
    const { client: bedrock, converse } = client();

    await fromBedrock(bedrock, {
      forcedToolChoiceUnsupportedModels: () => false,
    }).chat.completions.create(
      request('anthropic.claude-opus-5-5-v1:0', { tools, tool_choice: 'required' }),
      { signal },
    );

    expect((converse.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      toolConfig: { toolChoice: { any: {} } },
    });
  });
});

describe('forced tool_choice rejection through VernLLM', () => {
  it('is never retried, never counts toward the breaker, and still falls back', async () => {
    const create = vi.fn();
    const anthropic = { messages: { create } } as unknown as AnthropicClient;
    const fallbackCreate = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'c', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          },
        },
      ],
    }));

    const llm = new VernLLM({
      client: fromAnthropic(anthropic),
      model: 'claude-opus-5-5',
      maxRetries: 3,
      circuitBreaker: { threshold: 1 },
      fallback: { client: { chat: { completions: { create: fallbackCreate } } }, model: 'other' },
      logger: 'silent',
    });

    const tool = { name: 'lookup', description: 'Looks up', parameters: { type: 'object' } };
    await llm.call({ userContent: 'hi', tools: [tool], toolChoice: 'required' });

    expect(create).not.toHaveBeenCalled();
    expect(fallbackCreate).toHaveBeenCalledOnce();
    expect(llm.getCircuitState()).toBe('closed');
  });
});
