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

import { brandIcons } from './brand-icons';

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
  { name: 'AWS Bedrock', Icon: Bedrock, href: '/docs/integrations/bedrock' },
  { name: 'Custom HTTPS API', Icon: Globe, href: '/docs/adapters/custom-fetch' },
];

export const extensions = [
  {
    name: 'Logger',
    logo: '/extensions/vernllm-logger.png',
    href: '/docs/extensions/logger',
    description:
      'One structured record per call, rolling latency percentiles, slow call and error detection.',
  },
  {
    name: 'Usage',
    logo: '/extensions/vernllm-usage.png',
    href: '/docs/extensions/usage',
    description:
      'Estimated cost and wasted spend per call, plus token and dollar budgets that reject early.',
  },
  {
    name: 'Router',
    logo: '/extensions/vernllm-router.png',
    href: '/docs/extensions/router',
    description:
      'Orders targets by rules, health, latency, or cost, with a dry run and shadow mode.',
  },
  {
    name: 'Policy',
    logo: '/extensions/vernllm-policy.png',
    href: '/docs/extensions/policy',
    description: 'Removes forbidden targets, fails safe, and audits every decision.',
  },
  {
    name: 'Guard',
    logo: '/extensions/vernllm-guard.png',
    href: '/docs/extensions/guard',
    description:
      'Labels, redacts or blocks what goes into a call and what comes out, streams included.',
  },
  {
    name: 'Hedge',
    logo: '/extensions/vernllm-hedge.png',
    href: '/docs/extensions/hedge',
    description: 'Sends a slow call to the next target too and keeps the first answer.',
  },
];

export const integrations = [
  {
    name: 'Redis',
    icon: brandIcons['Redis'],
    href: '/docs/integrations/redis',
    description: 'One shared state for breakers, limits, budgets, and cache across every instance.',
  },
  {
    name: 'OpenTelemetry',
    icon: brandIcons['OpenTelemetry'],
    href: '/docs/integrations/otel',
    description: 'Every call becomes a trace and metrics in your observability stack.',
  },
  {
    name: 'AWS Bedrock',
    icon: brandIcons['Bedrock'],
    href: '/docs/integrations/bedrock',
    description: 'Every Bedrock model and guardrail, through the AWS SDK you already use.',
  },
];

export const codeExample = `import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';
import { fromAnthropic, fromOpenAI } from 'vern-llm/adapters';

const openai = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
const anthropic = fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

export const llm = new VernLLM({
  client: openai,
  model: 'gpt-6-sol',
  fallback: { client: anthropic, model: 'claude-opus-5-5', circuitBreaker: true },
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
    question:
      'My provider returns a 200, but the answer is empty, cut off, or an error hidden in the stream. Who catches that?',
    answer:
      'Retry logic that keys on status codes misses these. VernLLM judges the answer: an empty body fails, JSON cut off at `max_tokens` becomes a retryable `response_truncated` error, and a stream that errors before its first content chunk is retried or falls back, even after a keep alive ping opened it. `detectSoftFailure` flags anything else you consider broken, and each failure counts against that target breaker.',
  },
  {
    question: 'A provider outage multiplies my traffic with retries. How do I stop a retry storm?',
    answer:
      'A retry budget caps retries at a share of each target traffic over a rolling window, so retries stop before they pile onto a struggling provider. Retries also use full jitter and honor `Retry-After`. Set your provider SDK to `maxRetries: 0`, since the OpenAI, Anthropic, and Gemini SDKs retry on their own and would stack on top.',
  },
  {
    question:
      'During an outage every request still waits on the failing provider. How do I fail over fast?',
    answer:
      'Each target has its own circuit breaker. Once the primary opens, calls skip it and go straight to the fallback instead of paying for failed attempts first. Recovery uses half open trial calls rather than a timer, and your own errors, such as a bad request or a schema failure, never trip it. With `vern-llm-redis` the breaker state is shared across instances.',
  },
  {
    question: 'How do I stay under my provider rate limit instead of collecting 429s?',
    answer:
      'A `rateLimit` such as `{ requestsPerMinute: 500 }` estimates tokens before each call, queues calls within your request, token, and concurrency limits, then reconciles with real usage. It shrinks the limit after a 429, or ahead of one when the provider reports few requests left. Every target has its own limiter, so a burst against a struggling primary cannot starve a healthy fallback, and `vern-llm-redis` shares the buckets across processes.',
  },
  {
    question: 'What happens to streams that stall, fail midway, or get abandoned by the user?',
    answer:
      'A stream that fails before its first content chunk is retried or falls back. Once text has reached the caller it is not replayed, since that would duplicate output you may have already rendered. An idle chunk timeout catches a provider that stalls mid stream and counts it against the breaker, and leaving a `for await` loop early cancels the provider stream and frees the rate limit slot.',
  },
  {
    question: 'Some calls are not failing, just slow. How do I cut the tail?',
    answer:
      'A timeout only helps after the wait. `vern-llm-hedge` starts the same call on your next provider once the first answer takes longer than that target usually does, keeps whichever answers first, and cancels the other. The delay is learned from logger latency percentiles, a token bucket caps the extra traffic at about 5% of calls, and usage reports what hedging costs.',
  },
  {
    question:
      'How do I make sure sensitive data never falls back to a provider it should not reach?',
    answer:
      '`vern-llm-guard` finds values like secrets or PII and redacts, labels, or blocks them, streams included. `vern-llm-policy` then removes every target that keeps data or sits in the wrong region, and a removed target can never return through a retry or a fallback. A rule or label that cannot be evaluated fails closed. The built in detectors are heuristics, so run them in audit mode first and treat them as a layer, not a guarantee.',
  },
  {
    question:
      'How do I keep one tenant or feature from burning my budget, and see what failed calls cost?',
    answer:
      '`vern-llm-usage` checks budgets such as `{ key: "tenantId", limitUsd: 50, per: "day" }` before the call is sent, so an over budget call is rejected without contacting the provider. It also reports spend on attempts whose response was then rejected. Costs are estimates from your own price table, so the provider invoice stays the source of truth.',
  },
];

// Plain text for structured data, without the backticks that mark code in answers.
export const faqPlain = faqItems.map(({ question, answer }) => ({
  question,
  answer: answer.replace(/`/g, ''),
}));
