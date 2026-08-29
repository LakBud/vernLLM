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

export const codeExample = `import OpenAI from 'openai';
import { fromOpenAI, VernLLM } from 'vern-llm';
import { getWeatherTool } from './tools';

const openai = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
const backup = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_KEY_2 }));

export const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  maxRetries: 3,
  timeoutMs: 10_000,
  circuitBreaker: true,
  fallback: { client: backup, model: 'gpt-4o' },
  rateLimit: { requestsPerMinute: 500 }
});

export const { chunks, finalResult } = await llm.cachedCall({
  cacheKey: 'weather:new-york',
  ttl: 3600,
  call: {
    userContent: "What's the weather in New York?",
    tools: [getWeatherTool],
    stream: true
  }
});

for await (const chunk of chunks) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
}`;

export const annotations = [
  {
    line: 'maxRetries: 3',
    note: 'Retries transient failures with backoff and jitter',
  },
  {
    line: 'timeoutMs: 10_000',
    note: 'Prevents attempts from hanging indefinitely',
  },
  {
    line: 'circuitBreaker: true',
    note: 'Stops repeated failures from cascading',
  },
  {
    line: 'fallback:',
    note: 'Falls over to a backup target on failure',
  },
  {
    line: 'rateLimit:',
    note: 'Queues locally under a per-minute ceiling',
  },
  {
    line: 'cachedCall',
    note: 'Returns cached results without another API call',
  },
  {
    line: 'cacheKey',
    note: 'Identifies repeatable cached requests',
  },
  {
    line: 'ttl: 3600',
    note: 'Controls cache lifetime',
  },
  {
    line: 'tools',
    note: 'Lets the model request app defined functions',
  },
  {
    line: 'stream: true',
    note: 'Delivers live chunks with validated result',
  },
];
export const faqItems = [
  {
    question: 'What problem does VernLLM solve?',
    answer:
      'LLM calls fail in ways plain SDK calls do not handle: timeouts, rate limit errors, a provider having an outage, or a request that just hangs. VernLLM adds retries with backoff, a circuit breaker, provider fallback, rate limiting, and caching around your existing client, so a single bad call does not take down your app.',
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
