import { describe, it, expect } from 'vitest';

import {
  fromAnthropic,
  fromOpenAICompatible,
  type AnthropicClient,
  type BedrockConverseClient,
  type GeminiClient,
  type LLMClient,
  type JsonSchemaSpec,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports adapters at runtime', () => {
    expect(fromAnthropic).toBeDefined();
    expect(fromOpenAICompatible).toBeDefined();
  });

  it('exports public client and schema types', () => {
    const assertClient = (_client: LLMClient) => _client;
    const assertAnthropicClient = (_client: AnthropicClient) => _client;
    const assertGeminiClient = (_client: GeminiClient) => _client;
    const assertBedrockClient = (_client: BedrockConverseClient) => _client;
    const assertSchema = (_schema: JsonSchemaSpec) => _schema;

    expect(assertClient).toBeDefined();
    expect(assertAnthropicClient).toBeDefined();
    expect(assertGeminiClient).toBeDefined();
    expect(assertBedrockClient).toBeDefined();
    expect(assertSchema).toBeDefined();
  });
});
