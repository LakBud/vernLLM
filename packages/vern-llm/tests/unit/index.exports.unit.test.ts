import { describe, it, expect } from 'vitest';

import {
  fromAnthropic,
  fromOpenAICompatible,
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
    const assertSchema = (_schema: JsonSchemaSpec) => _schema;

    expect(assertClient).toBeDefined();
    expect(assertSchema).toBeDefined();
  });
});
