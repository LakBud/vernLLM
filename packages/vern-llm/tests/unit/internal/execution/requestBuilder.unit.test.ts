import { describe, expect, it } from 'vitest';

import { RequestBuilder } from '../../../../src/internal/execution/requestBuilder.js';

import type { CallParams } from '../../../../src/types/index.js';

function baseOptions() {
  return {
    model: 'default-model',
    defaultMaxTokens: 1024,
    defaultTemperature: 0.2,
    supportsJsonObjectMode: true,
  };
}

describe('RequestBuilder.build, defaults', () => {
  it('applies the instance model/maxTokens/temperature defaults when the call omits them', () => {
    const builder = new RequestBuilder(baseOptions());

    const { model, request } = builder.build({ userContent: 'hi' });

    expect(model).toBe('default-model');
    expect(request).toMatchObject({ model: 'default-model', max_tokens: 1024, temperature: 0.2 });
  });

  it('lets a per-call override win over the instance defaults', () => {
    const builder = new RequestBuilder(baseOptions());

    const { model, request } = builder.build({
      userContent: 'hi',
      model: 'gpt-override',
      maxTokens: 50,
      temperature: 0.9,
    });

    expect(model).toBe('gpt-override');
    expect(request).toMatchObject({ model: 'gpt-override', max_tokens: 50, temperature: 0.9 });
  });

  it('omits temperature from the request entirely when the resolved value is null', () => {
    const builder = new RequestBuilder({ ...baseOptions(), defaultTemperature: null });

    const { request } = builder.build({ userContent: 'hi' });

    expect(request).not.toHaveProperty('temperature');
  });
});

describe('RequestBuilder.build, message assembly', () => {
  it('builds a single user message for a call with no systemPrompt or history', () => {
    const builder = new RequestBuilder(baseOptions());

    const { request } = builder.build({ userContent: 'hello' });

    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('prepends a system message when systemPrompt is set', () => {
    const builder = new RequestBuilder(baseOptions());

    const { request } = builder.build({ userContent: 'hi', systemPrompt: 'be helpful' });

    expect(request.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
  });

  it('expands history before the current user turn', () => {
    const builder = new RequestBuilder(baseOptions());

    const { request } = builder.build({
      userContent: 'and then?',
      history: [
        { role: 'user', content: 'once upon a time' },
        { role: 'assistant', content: 'there was a dragon' },
      ],
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'once upon a time' },
      { role: 'assistant', content: 'there was a dragon' },
      { role: 'user', content: 'and then?' },
    ]);
  });
});

describe('RequestBuilder.build, useJson', () => {
  it('defaults useJson to true with no tools', () => {
    const builder = new RequestBuilder(baseOptions());

    expect(builder.build({ userContent: 'hi' }).useJson).toBe(true);
  });

  it('defaults useJson to false when tools are set', () => {
    const builder = new RequestBuilder(baseOptions());

    const { useJson, request } = builder.build({
      userContent: 'hi',
      tools: [{ name: 'search', description: 'x', parameters: {} }],
    });

    expect(useJson).toBe(false);
    expect(request).toHaveProperty('tools');
    expect(request).toHaveProperty('tool_choice');
  });
});

describe('RequestBuilder.build, delegates validation to the extracted functions', () => {
  it('throws for an empty tools array (from validateTools)', () => {
    const builder = new RequestBuilder(baseOptions());

    expect(() => builder.build({ userContent: 'hi', tools: [] })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws for a jsonMode: true call on a client without json object support (from resolveJsonMode)', () => {
    const builder = new RequestBuilder({ ...baseOptions(), supportsJsonObjectMode: false });

    expect(() => builder.build({ userContent: 'hi', jsonMode: true })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws for history ending on a user turn (from validateHistory)', () => {
    const builder = new RequestBuilder(baseOptions());

    expect(() =>
      builder.build({
        userContent: 'hi',
        history: [{ role: 'user', content: 'unanswered' }],
      } satisfies CallParams<unknown>),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });
});
