import { describe, expect, it } from 'vitest';

import { createRequestFacts } from '../../../src/internal/match/requestFacts.utils.js';

import type { WireCallRequest } from 'vern-llm';

const base: WireCallRequest = {
  model: 'm',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'x'.repeat(400) }],
};

describe('createRequestFacts', () => {
  it('estimates input tokens without the reserved output', () => {
    expect(createRequestFacts(base).inputTokens).toBe(100);
  });

  it('reads tools, json output and schemas', () => {
    const facts = createRequestFacts({
      ...base,
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] as never,
      response_format: { type: 'json_object' },
    });
    expect(facts).toMatchObject({ hasTools: true, jsonOutput: true, jsonSchema: false });
  });

  it('sees an image block in a user message', () => {
    const facts = createRequestFacts({
      ...base,
      messages: [{ role: 'user', content: [{ type: 'image', url: 'u' } as never] }],
    });
    expect(facts.images).toBe(true);
    expect(createRequestFacts(base).images).toBe(false);
  });
});
