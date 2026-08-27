import { describe, it, expect } from 'vitest';

import {
  fromAnthropic,
  fromBedrock,
  fromOpenAICompatible,
  NormalizedCacheAdapter,
  TieredCacheAdapter,
  parseSseStream,
  SSE_PING,
  isLLMError,
  hasIssues,
  isFallbackExhaustedError,
  FallbackExhaustedError,
  LLMError,
  createMiddleware,
  createStateKey,
  createMiddlewareStateBag,
  type AnthropicClient,
  type BedrockConverseClient,
  type GeminiClient,
  type LLMClient,
  type JsonSchemaSpec,
  type RetryAttempt,
  type VernLLMMiddleware,
  type MiddlewareContext,
  type MiddlewareCapabilities,
  type MiddlewareStateBag,
  type WireCallRequest,
  type WireCallRequestPatch,
  type CallResult,
  type CreateMiddlewareOptions,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports adapters at runtime', () => {
    expect(fromAnthropic).toBeDefined();
    expect(fromOpenAICompatible).toBeDefined();
    expect(fromBedrock).toBeDefined();
    expect(typeof fromBedrock).toBe('function');
  });

  it('exports cache adapters at runtime', () => {
    expect(NormalizedCacheAdapter).toBeDefined();
    expect(TieredCacheAdapter).toBeDefined();
  });

  it('exports parseSseStream and SSE_PING from the package root, not just internal/sse.js', () => {
    expect(parseSseStream).toBeDefined();
    expect(typeof parseSseStream).toBe('function');
    expect(SSE_PING).toBeDefined();
    expect(typeof SSE_PING).toBe('symbol');
  });

  it('exports isLLMError and hasIssues as runtime functions from the package root', () => {
    expect(typeof isLLMError).toBe('function');
    expect(typeof hasIssues).toBe('function');

    expect(isLLMError(new LLMError('boom', 'unknown'))).toBe(true);
    expect(isLLMError(new Error('plain error'))).toBe(false);
    expect(isLLMError('not an error')).toBe(false);
    expect(isLLMError(undefined)).toBe(false);

    const withIssues = new LLMError('dup', 'invalid_params', {
      code: 'duplicate_tool_names',
      issues: { names: ['a'] },
    });
    const withoutIssues = new LLMError('unrelated', 'invalid_params', {
      code: 'unsupported_capability',
    });

    expect(hasIssues(withIssues, 'duplicate_tool_names')).toBe(true);
    expect(hasIssues(withIssues, 'unsupported_capability')).toBe(false);
    expect(hasIssues(withoutIssues, 'duplicate_tool_names')).toBe(false);
  });

  it('exports isFallbackExhaustedError as a runtime function from the package root', () => {
    expect(typeof isFallbackExhaustedError).toBe('function');

    const exhausted = new FallbackExhaustedError([
      { index: -1, provider: 'primary', model: 'm', error: new LLMError('down', 'api') },
      { index: 0, provider: 'fallback-1', model: 'm2', error: new LLMError('down', 'api') },
    ]);

    expect(isFallbackExhaustedError(exhausted)).toBe(true);
    expect(isFallbackExhaustedError(new LLMError('down', 'api'))).toBe(false);
  });

  it('exports public client and schema types', () => {
    const assertClient = (_client: LLMClient) => _client;
    const assertAnthropicClient = (_client: AnthropicClient) => _client;
    const assertGeminiClient = (_client: GeminiClient) => _client;
    const assertBedrockClient = (_client: BedrockConverseClient) => _client;
    const assertSchema = (_schema: JsonSchemaSpec) => _schema;
    const assertRetryAttempt = (_attempt: RetryAttempt) => _attempt;

    expect(assertClient).toBeDefined();
    expect(assertAnthropicClient).toBeDefined();
    expect(assertGeminiClient).toBeDefined();
    expect(assertBedrockClient).toBeDefined();
    expect(assertSchema).toBeDefined();
    expect(assertRetryAttempt).toBeDefined();
  });

  it('exports createMiddleware, createStateKey, and createMiddlewareStateBag as runtime functions from the package root', () => {
    expect(typeof createMiddleware).toBe('function');
    expect(typeof createStateKey).toBe('function');
    expect(typeof createMiddlewareStateBag).toBe('function');

    const key = createStateKey<string>('test.key');
    const bag = createMiddlewareStateBag();
    bag.set(key, 'value');
    expect(bag.get(key)).toBe('value');

    const middleware = createMiddleware({ name: 'test', onError: () => {} });
    expect(middleware.name).toBe('test');
    expect(typeof middleware.wrap).toBe('function');
  });

  it('exports the middleware type surface from the package root', () => {
    const assertMiddleware = (_m: VernLLMMiddleware) => _m;
    const assertContext = (_ctx: MiddlewareContext) => _ctx;
    const assertCapabilities = (_c: MiddlewareCapabilities) => _c;
    const assertStateBag = (_b: MiddlewareStateBag) => _b;
    const assertRequest = (_r: WireCallRequest) => _r;
    const assertPatch = (_p: WireCallRequestPatch) => _p;
    const assertResult = (_r: CallResult) => _r;
    const assertCreateOptions = (_o: CreateMiddlewareOptions) => _o;

    expect(assertMiddleware).toBeDefined();
    expect(assertContext).toBeDefined();
    expect(assertCapabilities).toBeDefined();
    expect(assertStateBag).toBeDefined();
    expect(assertRequest).toBeDefined();
    expect(assertPatch).toBeDefined();
    expect(assertResult).toBeDefined();
    expect(assertCreateOptions).toBeDefined();
  });
});
