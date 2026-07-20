import Link from 'next/link';

import Squares from './Squares';

const features = [
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

const providers = ['OpenAI-compatible APIs', 'Anthropic', 'Gemini', 'AWS Bedrock', 'Custom APIs'];

const codeExample = `import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';

const llm = new VernLLM({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',

  maxRetries: 3,
  timeoutMs: 10_000,
  circuitBreaker: true,

  onUsage: ({ totalTokens }) => {
    console.log(\`Used \${totalTokens} tokens\`);
  },
});

const summary = await llm.cachedLLMCall({
  cacheKey: \`resume:\${resumeId}\`,
  ttl: 3600,
  call: {
    systemPrompt: 'Analyze this resume and return structured hiring insights.',
    userContent: resumeText,
    schema: HiringSummarySchema, // Zod schema
  },
});`;

const annotations = [
  { line: 'maxRetries: 3', note: '3 attempts with exponential backoff' },
  { line: 'timeoutMs: 10_000', note: '10s hard timeout per attempt' },
  { line: 'circuitBreaker: true', note: 'trips after repeated failures' },
  { line: 'onUsage', note: 'token usage reported per call' },
  { line: 'cachedLLMCall', note: 'identical calls skip the network' },
  { line: 'schema', note: 'response validated and typed via Zod' },
];

export default function HomePage() {
  return (
    <div className="flex flex-col flex-1 bg-fd-background">
      {/* ---------- HERO  ---------- */}
      <div className="relative overflow-hidden">
        <Squares squareSize={44} />

        <section className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 px-6 lg:px-16 pt-24 pb-20 items-end">
          <div className="lg:col-span-8">
            <h1 className="font-bold leading-[0.95] text-fd-foreground text-[13vw] lg:text-[6.5vw] tracking-tight">
              Reliable LLM calls,
              <br />
              by default.
            </h1>
            <p className="mt-6 text-fd-muted-foreground text-base lg:text-lg max-w-xl">
              A lightweight resilience layer for OpenAI-compatible chat completions: retries,
              timeouts, caching, and circuit breaking, dependency-light and typed from the start.
            </p>
          </div>

          <div className="lg:col-span-4 flex flex-col items-start lg:items-end gap-6 lg:text-right">
            <div className="flex gap-2">
              <Link
                href="/docs"
                className="inline-flex items-center gap-1.5 rounded-md border border-fd-border px-3 py-1.5 text-sm font-medium  bg-fd-primary text-fd-primary-foreground hover:opacity-90 transition-opacity"
              >
                Read the docs
              </Link>
              <a
                href="https://github.com/LakBud/vernLLM"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent transition-colors"
              >
                Source
              </a>
            </div>
          </div>
        </section>
      </div>

      {/* ---------- INSTALL STRIP ---------- */}
      <section className="border-y border-fd-border">
        <div className="px-6 lg:px-16 py-4 flex items-center justify-between max-w-5xl mx-auto w-full">
          <code className="font-mono text-sm text-fd-foreground">
            <span className="text-fd-muted-foreground">$</span> npm install vern-llm
          </code>
          <span className="font-mono text-xs text-fd-muted-foreground hidden sm:inline">
            built around the clients you already use
          </span>
        </div>
      </section>

      {/* ---------- CODE EXAMPLE ---------- */}
      <section className="px-6 lg:px-16 py-20">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-8">
            <div className="rounded-lg border border-fd-border bg-fd-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-fd-border">
                <span className="font-mono text-xs text-fd-muted-foreground">example.ts</span>
                <button
                  type="button"
                  className="font-mono text-xs text-fd-muted-foreground hover:text-fd-foreground transition-colors"
                >
                  Copy
                </button>
              </div>
              <pre className="p-5 overflow-x-auto text-sm leading-relaxed">
                <code className="font-mono text-fd-card-foreground whitespace-pre">
                  {codeExample}
                </code>
              </pre>
            </div>
          </div>

          <div className="lg:col-span-4 flex flex-col justify-center gap-5">
            <h2 className="text-fd-foreground text-lg font-semibold">
              One config. Every failure mode covered.
            </h2>
            <ul className="flex flex-col gap-3">
              {annotations.map((a) => (
                <li key={a.line} className="flex flex-col gap-0.5">
                  <code className="font-mono text-xs text-fd-primary">{a.line}</code>
                  <span className="text-sm text-fd-muted-foreground">→ {a.note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- FEATURE LIST ---------- */}
      <section className="px-6 lg:px-16 pb-20">
        <div className="max-w-4xl mx-auto flex flex-col">
          {features.map((f, i) => (
            <div
              key={f.code}
              className={`grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-6 py-6 ${
                i !== 0 ? 'border-t border-fd-border' : ''
              }`}
            >
              <code className="sm:col-span-5 font-mono text-sm text-fd-primary self-start break-all">
                {f.code}
              </code>
              <div className="sm:col-span-7 flex flex-col gap-1">
                <h3 className="text-fd-foreground font-semibold text-sm">{f.title}</h3>
                <p className="text-sm text-fd-muted-foreground leading-relaxed">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- PROVIDER STRIP ---------- */}
      <section className="px-6 lg:px-16 pb-20">
        <div className="max-w-6xl mx-auto flex flex-col items-center gap-4">
          <span className="text-[60px] font-semibold ">Works with</span>
          <div className="flex flex-wrap justify-center gap-2">
            {providers.map((p) => (
              <span
                key={p}
                className="rounded-md border text-[20px] border-fd-border px-3 py-1.5 text-xs text-fd-primary"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- WHY VERN-LLM  ---------- */}
      <section className="px-6 lg:px-16 pb-24">
        <div className="max-w-2xl mx-auto flex flex-col gap-4">
          <h2 className="text-fd-foreground text-2xl font-bold">Why vern-llm?</h2>
          <p className="text-fd-muted-foreground leading-relaxed">
            Every project calling an LLM API ends up writing the same defensive code; retry logic,
            timeouts, a circuit breaker, a cache layer, usually copied between projects and slightly
            wrong each time.
          </p>
          <p className="text-fd-muted-foreground leading-relaxed">
            vern-llm is a thin, dependency-light wrapper that gives you these primitives with
            sensible defaults out of the box, and lets you override exactly what you need. It works
            with any OpenAI-compatible client, plus Anthropic, Gemini, and Bedrock adapters. No
            vendor lock-in.
          </p>
        </div>
      </section>

      {/* FOOTER CTA */}
      <section className="border-t border-fd-border">
        <div className="px-6 lg:px-16 py-16 max-w-6xl mx-auto w-full flex flex-col items-center text-center gap-6">
          <h2 className="text-fd-foreground text-xl sm:text-3xl font-bold max-w-xl">
            Stop reinventing the resilience layer.
          </h2>

          <div className="lg:col-span-4 flex flex-col items-start lg:items-end gap-6 lg:text-right">
            <div className="flex gap-2">
              <Link
                href="/docs"
                className="inline-flex items-center gap-1.5 rounded-md border border-fd-border px-3 py-1.5 text-sm font-medium  bg-fd-primary text-fd-primary-foreground hover:opacity-90 transition-opacity"
              >
                Get started
              </Link>
              <a
                href="https://github.com/LakBud/vernLLM"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 text-sm font-medium text-fd-foreground hover:bg-fd-accent transition-colors"
              >
                Source
              </a>
            </div>
          </div>

          <code className="font-mono text-xs text-fd-muted-foreground">npm install vern-llm</code>
        </div>
      </section>
    </div>
  );
}
