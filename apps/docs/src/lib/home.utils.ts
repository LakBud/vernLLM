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
  Github,
  Grok,
  Groq,
  Hyperbolic,
  Inference,
  Infermatic,
  Kluster,
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
  { name: 'GitHub Models', Icon: Github, href: '/docs/adapters/openai-compatible' },
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
  { name: 'kluster.ai', Icon: Kluster, href: '/docs/adapters/openai-compatible' },
  { name: 'Inference.net', Icon: Inference, href: '/docs/adapters/openai-compatible' },
  { name: 'Infermatic', Icon: Infermatic, href: '/docs/adapters/openai-compatible' },
  { name: 'AtlasCloud', Icon: AtlasCloud, href: '/docs/adapters/openai-compatible' },
  { name: '01.AI (Yi)', Icon: Yi, href: '/docs/adapters/openai-compatible' },
  { name: 'AWS Bedrock', Icon: Bedrock, href: '/docs/adapters/bedrock' },
  { name: 'Custom HTTPS API', Icon: Globe, href: '/docs/adapters/custom-fetch' },
];

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

export const codeExample = `import OpenAI from 'openai';
import { z } from 'zod';
import { VernLLM } from 'vern-llm';

const resumeId = 'candidate-123';
const resumeText = 'Software engineer with 5 years of experience';

const HiringSummarySchema = z.object({
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  recommendation: z.string(),
});

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

/**
 * Identifiers in `codeExample` that VernLLM itself introduces (as opposed to
 * plain OpenAI/Zod/JS syntax). Rendered in orange in the code block so the
 * library's surface area stands out at a glance.
 */
export const codeHighlightKeywords = [
  'VernLLM',
  'vern-llm',
  'maxRetries',
  'timeoutMs',
  'circuitBreaker',
  'onUsage',
  'totalTokens',
  'cachedLLMCall',
  'cacheKey',
  'schema',
];

export const annotations = [
  { line: 'maxRetries: 3', note: '3 attempts with exponential backoff' },
  { line: 'timeoutMs: 10_000', note: '10s hard timeout per attempt' },
  { line: 'circuitBreaker: true', note: 'Trips after repeated failures' },
  { line: 'onUsage', note: 'Token usage reported per call' },
  { line: 'cachedLLMCall', note: 'Identical calls skip the network' },
  { line: 'schema', note: 'Response validated and typed via Zod' },
];

export const faqItems = [
  {
    question: 'Why use VernLLM instead of calling the client directly?',
    answer:
      'Every project calling an LLM API ends up writing the same defensive code: retry logic, timeouts, a circuit breaker, a cache layer, usually copied between projects and slightly wrong each time. VernLLM gives you those primitives with sensible defaults out of the box, so you keep your existing client and just wrap it.',
  },
  {
    question: 'Do I need to change how I call my LLM client?',
    answer:
      'No. VernLLM wraps the client you already have, OpenAI, Anthropic, Gemini, Bedrock, or anything OpenAI-compatible, so you keep your existing setup and just route calls through it.',
  },
  {
    question: 'Can I bring my own cache backend?',
    answer:
      'Yes. cachedLLMCall works with any adapter implementing get/set/delete, so you can plug in Redis, a database, or your own store instead of the built-in in-memory cache.',
  },
  {
    question: 'Is it typed?',
    answer:
      'Yes, written in TypeScript from the ground up. Structured output schemas, call params, and errors are all typed, so mistakes surface at compile time instead of at runtime.',
  },
  {
    question: 'How many dependencies does it add to my project?',
    answer:
      'Zero bundled dependencies. Zod and provider SDKs are peer dependencies, and VernLLM only relies on their shapes structurally, so it stays dependency-light and typed from the start.',
  },
  {
    question: 'How big is the bundle?',
    answer:
      '12.1 kB minified, 4.4 kB minified and gzipped. Small enough to drop into a project without thinking twice about it.',
  },
  {
    question: 'Is it open source?',
    answer:
      'Yes, VernLLM is MIT licensed and open source. Use it in personal or commercial projects, fork it, or contribute back on GitHub.',
  },
];
