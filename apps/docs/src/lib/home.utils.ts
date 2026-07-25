import {
  Anthropic,
  Bedrock,
  Cerebras,
  DeepInfra,
  DeepSeek,
  Fireworks,
  Gemini,
  Groq,
  Hyperbolic,
  LmStudio,
  Mistral,
  Moonshot,
  Novita,
  Ollama,
  OpenAI,
  OpenRouter,
  Perplexity,
  Together,
  Vllm,
  Zhipu,
} from '@lobehub/icons';
import { Globe } from 'lucide-react';

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
    body: 'Trips after repeated failures and rejects immediately while open. Call getCircuitState() to inspect it.',
  },
  {
    code: `nonRetryableStatus: [400, 401, 403]`,
    title: 'Fail-fast status codes',
    body: 'Status codes you mark as non-retryable skip the retry loop entirely.',
  },
  {
    code: `llm.cachedLLMCall({ cacheKey, ttl, call })`,
    title: 'Caching',
    body: 'Wraps call() with a pluggable cache adapter. Identical calls return without hitting the network.',
  },
  {
    code: `schema: HiringSummarySchema`,
    title: 'Structured output',
    body: 'Pass a Zod schema inside call params and receive validated, typed JSON.',
  },
  {
    code: `onUsage: ({ totalTokens }) => {}`,
    title: 'Usage tracking',
    body: 'Reports prompt, completion, and total tokens whenever the provider returns usage data.',
  },
  {
    code: `logger: myLogger`,
    title: 'Pluggable logger',
    body: 'Bring your own Logger implementation or fall back to the built-in console logger.',
  },
];

export const providers = [
  { name: 'OpenAI', Icon: OpenAI, href: '/docs/adapters' },
  { name: 'Anthropic', Icon: Anthropic, href: '/docs/adapters/anthropic' },
  { name: 'Gemini', Icon: Gemini, href: '/docs/adapters/gemini' },
  { name: 'Groq', Icon: Groq, href: '/docs/adapters/openai-compatible' },
  { name: 'Mistral', Icon: Mistral, href: '/docs/adapters/openai-compatible' },
  { name: 'DeepSeek', Icon: DeepSeek, href: '/docs/adapters/openai-compatible' },
  { name: 'Cerebras', Icon: Cerebras, href: '/docs/adapters/openai-compatible' },
  { name: 'Together AI', Icon: Together, href: '/docs/adapters/openai-compatible' },
  { name: 'Fireworks AI', Icon: Fireworks, href: '/docs/adapters/openai-compatible' },
  { name: 'Ollama', Icon: Ollama, href: '/docs/adapters/openai-compatible' },
  { name: 'OpenRouter', Icon: OpenRouter, href: '/docs/adapters/openai-compatible' },
  { name: 'Perplexity', Icon: Perplexity, href: '/docs/adapters/openai-compatible' },
  { name: 'DeepInfra', Icon: DeepInfra, href: '/docs/adapters/openai-compatible' },
  { name: 'Novita', Icon: Novita, href: '/docs/adapters/openai-compatible' },
  { name: 'Hyperbolic', Icon: Hyperbolic, href: '/docs/adapters/openai-compatible' },
  { name: 'Moonshot (Kimi)', Icon: Moonshot, href: '/docs/adapters/openai-compatible' },
  { name: 'Zhipu (GLM)', Icon: Zhipu, href: '/docs/adapters/openai-compatible' },
  { name: 'LM Studio', Icon: LmStudio, href: '/docs/adapters/openai-compatible' },
  { name: 'vLLM', Icon: Vllm, href: '/docs/adapters/openai-compatible' },
  { name: 'AWS Bedrock', Icon: Bedrock, href: '/docs/adapters/bedrock' },
  {
    name: 'Any HTTP API',
    Icon: Globe,
    href: '/docs/adapters/custom-fetch',
    className: 'text-fd-muted-foreground opacity-60',
  },
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
    schema: HiringSummarySchema,
  },
});`;

export const annotations = [
  { line: 'maxRetries: 3', note: '3 attempts with exponential backoff' },
  { line: 'timeoutMs: 10_000', note: '10s hard timeout per attempt' },
  { line: 'circuitBreaker: true', note: 'Trips after repeated failures' },
  { line: 'onUsage', note: 'Token usage reported per call' },
  { line: 'cachedLLMCall', note: 'Identical calls skip the network' },
  { line: 'schema', note: 'Response validated and typed via Zod' },
];
