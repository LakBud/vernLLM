import { LLMError, type LLMClient } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient } from '../helpers.js';

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

describe('fromBedrock, models that reject forced tool_choice', () => {
  function client() {
    const converse = vi.fn(async () => ({ output: { message: { content: [{ text: '{}' }] } } }));
    return { client: stubbedClient({ converse }), converse };
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

  it('names the tool in the error when a specific tool is forced', async () => {
    const { client: bedrock, converse } = client();

    const error = await fromBedrock(bedrock)
      .chat.completions.create(
        request('anthropic.claude-opus-5-5-v1:0', {
          tools,
          tool_choice: { type: 'function', function: { name: 'lookup' } },
        }),
        { signal },
      )
      .catch((e: unknown) => e);

    expect(converse).not.toHaveBeenCalled();
    expect((error as LLMError).message).toContain("toolChoice: { name: 'lookup' }");
  });

  it('rejects a forced choice on every Claude major 6 and later, whatever the family', async () => {
    const { client: bedrock, converse } = client();

    await expect(
      fromBedrock(bedrock).chat.completions.create(
        request('anthropic.claude-sonnet-6-v1:0', { tools, tool_choice: 'required' }),
        { signal },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('allows a forced choice on an older Claude family such as Sonnet 5', async () => {
    const { client: bedrock, converse } = client();

    await fromBedrock(bedrock).chat.completions.create(
      request('anthropic.claude-sonnet-5-v1:0', { tools, tool_choice: 'required' }),
      { signal },
    );

    expect(converse).toHaveBeenCalledOnce();
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
