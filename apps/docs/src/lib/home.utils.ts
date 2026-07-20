export const features = [
  {
    code: `maxRetries: 3`,
    title: 'Retry with backoff',
    body: 'Retries a failed call up to N times with exponential backoff and jitter between attempts.',
  },
  {
    code: `timeoutMs: 10_000`,
    title: 'Per-attempt timeout',
    body: 'Each attempt is raced against a hard timeout, so no single request can hang the call.',
  },
  {
    code: `circuitBreaker: true`,
    title: 'Circuit breaker',
    body: 'Trips after repeated failures and rejects immediately while open, call getCircuitState() to inspect it.',
  },
  {
    code: `nonRetryableStatus: [400, 401, 403]`,
    title: 'Fail-fast status codes',
    body: 'Status codes you mark as non-retryable skip the retry loop entirely, no point retrying a 401.',
  },
  {
    code: `llm.cachedLLMCall({ cacheKey, ttl, call })`,
    title: 'Caching',
    body: 'Wraps call() with a pluggable cache adapter, identical calls return without hitting the network.',
  },
  {
    code: `schema: HiringSummarySchema`,
    title: 'Structured output',
    body: 'Pass a Zod schema inside call params, get back parsed, validated, typed JSON or a validation error.',
  },
  {
    code: `onUsage: ({ totalTokens }) => {}`,
    title: 'Usage tracking',
    body: 'Reports prompt, completion, and total tokens per call, only fires when the provider returns usage data.',
  },
  {
    code: `logger: myLogger`,
    title: 'Pluggable logger',
    body: 'Bring your own Logger implementation, or fall back to the built-in console logger gated by debug.',
  },
];

export const providers = [
  'OpenAI-compatible APIs',
  'Anthropic',
  'Gemini',
  'AWS Bedrock',
  'Custom APIs',
];

export const codeExample = `import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';

export const llm = new VernLLM({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',

  maxRetries: 3,
  timeoutMs: 10_000,
  circuitBreaker: true,

  onUsage: ({ totalTokens }) => {
    console.log(\`Used \${totalTokens} tokens\`);
  },
});

export const summary = await llm.cachedLLMCall({
  cacheKey: \`resume:\${resumeId}\`,
  ttl: 3600,
  call: {
    systemPrompt: 'Analyze this resume and return structured hiring insights.',
    userContent: resumeText,
    schema: HiringSummarySchema, // Zod schema
  },
});`;

export const annotations = [
  { line: 'maxRetries: 3', note: '3 attempts with exponential backoff' },
  { line: 'timeoutMs: 10_000', note: '10s hard timeout per attempt' },
  { line: 'circuitBreaker: true', note: 'trips after repeated failures' },
  { line: 'onUsage', note: 'token usage reported per call' },
  { line: 'cachedLLMCall', note: 'identical calls skip the network' },
  { line: 'schema', note: 'response validated and typed via Zod' },
];
