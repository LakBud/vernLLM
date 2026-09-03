import {
  Anthropic,
  Anyscale,
  AtlasCloud,
  Baseten,
  Bedrock,
  Cerebras,
  Cloudflare,
  DeepInfra,
  DeepSeek,
  Featherless,
  Fireworks,
  Friendli,
  Gemini,
  Grok,
  Groq,
  Hyperbolic,
  Inference,
  Infermatic,
  Lambda,
  LeptonAI,
  LmStudio,
  Minimax,
  Mistral,
  Moonshot,
  Nebius,
  Novita,
  Nvidia,
  Ollama,
  OpenAI,
  OpenRouter,
  Parasail,
  Perplexity,
  SambaNova,
  SiliconCloud,
  Snowflake,
  Stepfun,
  Together,
  Vercel,
  Vllm,
  Yi,
  Zhipu,
} from '@lobehub/icons';
import { Globe } from 'lucide-react';

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
  { name: 'xAI (Grok)', Icon: Grok, href: '/docs/adapters/openai-compatible' },
  { name: 'NVIDIA NIM', Icon: Nvidia, href: '/docs/adapters/openai-compatible' },
  { name: 'Vercel AI Gateway', Icon: Vercel, href: '/docs/adapters/openai-compatible' },
  { name: 'Cloudflare Workers AI', Icon: Cloudflare, href: '/docs/adapters/openai-compatible' },
  { name: 'Nebius AI Studio', Icon: Nebius, href: '/docs/adapters/openai-compatible' },
  { name: 'SambaNova Cloud', Icon: SambaNova, href: '/docs/adapters/openai-compatible' },
  { name: 'Baseten', Icon: Baseten, href: '/docs/adapters/openai-compatible' },
  { name: 'Featherless AI', Icon: Featherless, href: '/docs/adapters/openai-compatible' },
  { name: 'Friendli AI', Icon: Friendli, href: '/docs/adapters/openai-compatible' },
  { name: 'SiliconFlow', Icon: SiliconCloud, href: '/docs/adapters/openai-compatible' },
  { name: 'Parasail', Icon: Parasail, href: '/docs/adapters/openai-compatible' },
  { name: 'StepFun', Icon: Stepfun, href: '/docs/adapters/openai-compatible' },
  { name: 'MiniMax', Icon: Minimax, href: '/docs/adapters/openai-compatible' },
  { name: 'Lambda Labs', Icon: Lambda, href: '/docs/adapters/openai-compatible' },
  { name: 'Snowflake Cortex', Icon: Snowflake, href: '/docs/adapters/openai-compatible' },
  { name: 'Anyscale', Icon: Anyscale, href: '/docs/adapters/openai-compatible' },
  { name: 'Lepton AI', Icon: LeptonAI, href: '/docs/adapters/openai-compatible' },
  { name: 'Inference.net', Icon: Inference, href: '/docs/adapters/openai-compatible' },
  { name: 'Infermatic', Icon: Infermatic, href: '/docs/adapters/openai-compatible' },
  { name: 'AtlasCloud', Icon: AtlasCloud, href: '/docs/adapters/openai-compatible' },
  { name: '01.AI (Yi)', Icon: Yi, href: '/docs/adapters/openai-compatible' },
  { name: 'AWS Bedrock', Icon: Bedrock, href: '/docs/adapters/bedrock' },
  { name: 'Custom HTTPS API', Icon: Globe, href: '/docs/adapters/custom-fetch' },
];

export const codeExample = `import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fromAnthropic, fromOpenAI, VernLLM } from 'vern-llm';

const openai = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
const anthropic = fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

export const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  fallback: { client: anthropic, model: 'claude-sonnet-5', circuitBreaker: true },
  rateLimit: { requestsPerMinute: 500, tokensPerMinute: 100_000, maxConcurrent: 20 },
  retryBudget: { windowMs: 60_000, minCalls: 20, retryRatio: 0.2 },
  maxRetries: 3,
  timeoutMs: 10_000,
  defaultMaxTokens: 1000,
  defaultReasoningEffort: 'medium'
});

const result = await llm.cachedCall({
  cacheKey: 'weather:new-york',
  ttl: 3600,
  call: { userContent: "What's the weather in New York?" }
});`;

export const annotations = [
  {
    line: 'fallback:',
    note: 'Falls over to a backup target on failure, in process',
  },
  {
    line: 'circuitBreaker: true',
    note: 'Stops repeated failures from cascading',
  },
  {
    line: 'rateLimit:',
    note: 'Queues locally under a per-minute ceiling',
  },
  {
    line: 'retryBudget:',
    note: 'Caps how much recent traffic can be retries',
  },
  {
    line: 'maxRetries: 3',
    note: 'Retries transient failures with backoff and jitter',
  },
  {
    line: 'timeoutMs: 10_000',
    note: 'Prevents attempts from hanging indefinitely',
  },
  {
    line: 'defaultMaxTokens: 1000',
    note: 'Applied to any call that omits its own',
  },
  {
    line: "defaultReasoningEffort: 'medium'",
    note: 'Sets reasoning depth across providers',
  },
  {
    line: 'cachedCall',
    note: 'Returns cached results without another API call',
  },
];
export const faqItems = [
  {
    question: 'What problem does VernLLM solve?',
    answer:
      'LLM calls fail in ways plain SDK calls do not handle: timeouts, rate limit errors, a provider having an outage, or a request that just hangs. VernLLM adds retries with backoff, a circuit breaker, provider fallback, rate limiting, and caching around your existing client, so a single bad call does not take down your app.',
  },
  {
    question: 'Why use VernLLM instead of a gateway?',
    answer:
      'VernLLM runs in your own process, so there is no extra network hop or proxy to maintain. It is built around small interfaces rather than one config object, so caching, rate limiting, and the circuit breaker can each be swapped for your own implementation. Running in-process also means it can react to your own application logic, not just the request and response, catching failures a gateway watching traffic from outside your app would miss. A gateway is still the better choice for one shared setup across many services or languages.',
  },
  {
    question: 'Why use VernLLM instead of calling the client directly?',
    answer:
      'Calling the client directly means you own retries, timeouts, circuit breaking, and caching yourself, code most teams end up rewriting per project. VernLLM ships those as configurable options on one class, so you keep your existing provider client and wrap it instead of reimplementing the resilience layer.',
  },
  {
    question: 'Can I bring my own cache backend?',
    answer:
      'Yes. cachedCall accepts any adapter implementing get/set (delete is optional), so Redis, a database, or a custom store can replace the built-in in-memory cache without changing how you call it.',
  },
  {
    question: 'Can I hook into or modify requests before they go out?',
    answer:
      'Yes, through middleware. transform edits or redacts an outgoing request before it is sent, and wrap runs around a whole logical call, retries and fallback attempts included, for logging, tracing, or cost tracking.',
  },
  {
    question: 'Is it typed?',
    answer:
      'Yes, written in TypeScript from the ground up. Structured output schemas, call params, and errors are all typed, so mistakes surface at compile time instead of at runtime.',
  },
  {
    question: 'How many dependencies does it add to my project?',
    answer:
      'Zero runtime dependencies. VernLLM does not bundle Zod or provider SDKs, it relies on compatible interfaces instead, so you bring your own provider clients and schema validators while keeping your dependency tree minimal.',
  },
];
