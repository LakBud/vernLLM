import Link from 'next/link';

import Squares from './Squares';

import { annotations, codeExample, features, providers } from '@/lib/home.utils';
import { generateSoftwareApplication, JsonLd } from '@/lib/seo/jsonld';

export default function HomePage() {
  return (
    <div className="flex flex-col flex-1 bg-fd-background">
      <JsonLd
        data={generateSoftwareApplication({
          name: 'vern-llm',
          description:
            'A lightweight resilience layer for OpenAI-compatible chat completion calls — retries, timeouts, circuit breaking, caching, structured output, and usage tracking, with one interface across providers.',
          url: 'https://vernllm.dev',
        })}
      />
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
