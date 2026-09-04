import { ServerCodeBlock } from '@fumadocs/base-ui/components/codeblock.rsc';
import { transformerIcon } from 'fumadocs-core/mdx-plugins';
import Link from 'next/link';
import { createCssVariablesTheme } from 'shiki';

import Squares from '../../components/squares';

import { AuroraBarsClient } from '@/components/aurora-bars-client';
import { InstallCommand } from '@/components/install-command';
import { MotionAccordion } from '@/components/unlumen-ui/motion-faqs-accordion';
import { annotations, codeExample, faqItems, providers } from '@/lib/home.utils';
import { generateSoftwareApplication, JsonLd } from '@/lib/seo/jsonld';

const buttonGroupClass = 'flex gap-2';

const primaryButtonClass =
  'inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90';

const secondaryButtonClass =
  'inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent';

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col bg-fd-background overflow-x-hidden">
      <JsonLd
        data={generateSoftwareApplication({
          name: 'VernLLM',
          description:
            'The LLM call framework. Resilience, observability, and control for every call.',
          url: 'https://vernllm.dev',
        })}
      />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <Squares squareSize={44} />

        <div className="relative z-10 grid grid-cols-1 items-end gap-8 px-6 pb-20 pt-24 lg:grid-cols-12 lg:px-16">
          <div className="lg:col-span-8">
            <h1 className="text-[13vw] font-bold leading-[0.95] tracking-tight text-fd-foreground lg:text-[6.5vw]">
              Reliable LLM calls,
              <br />
              by default.
            </h1>

            <p className="mt-6 max-w-xl text-base text-fd-muted-foreground lg:text-lg">
              The LLM call framework. Resilience, observability, and control for every call.
              Retries, timeouts, provider fallback, rate limiting, circuit breaking and more,
              dependency-light and typed from the start.
            </p>
          </div>

          <div className="flex flex-col items-start gap-6 lg:col-span-4 lg:items-end lg:text-right">
            <div className={buttonGroupClass}>
              <Link href="/docs/core" className={primaryButtonClass}>
                Read the docs
              </Link>

              <a
                href="https://github.com/LakBud/vernLLM"
                target="_blank"
                rel="noreferrer"
                className={secondaryButtonClass}
              >
                Source
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* INSTALL */}
      <section className="border-y border-fd-border">
        <div className="w-full py-4">
          <InstallCommand />
        </div>
      </section>

      {/* CODE */}
      <section className="px-6 py-20 lg:px-16">
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <ServerCodeBlock
              lang="ts"
              code={codeExample}
              transformers={[transformerIcon()]}
              themes={{
                light: createCssVariablesTheme({
                  name: 'vern',
                  variablePrefix: '--shiki-',
                  variableDefaults: {},
                  fontStyle: true,
                }),
                dark: createCssVariablesTheme({
                  name: 'vern',
                  variablePrefix: '--shiki-',
                  variableDefaults: {},
                  fontStyle: true,
                }),
              }}
              codeblock={{
                title: 'index.ts',
                className: 'rounded-lg border border-fd-border',
              }}
            />
          </div>

          <div className="flex flex-col justify-center gap-5 lg:col-span-4 text-center lg:text-left">
            <h2 className="text-xl font-semibold text-fd-foreground">
              What this call actually does.
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

      {/* PROVIDERS */}
      <section className="px-6 py-20 lg:px-16">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-8">
          <span className="pb-4 text-4xl font-semibold sm:text-5xl lg:text-[60px]">Works with</span>

          <div className="flex flex-wrap items-center justify-center gap-10">
            {providers.map(({ name, Icon, href }) =>
              Icon ? (
                <Link
                  key={name}
                  href={href}
                  className="group relative flex items-center justify-center"
                >
                  <Icon
                    aria-label={name}
                    className="h-12 w-12 text-fd-muted-foreground opacity-60 transition-colors hover:text-fd-card-foreground hover:opacity-100 md:h-17 md:w-17"
                  />

                  <span className="pointer-events-none absolute -bottom-10 z-10 whitespace-nowrap rounded-lg border bg-fd-background px-3 py-1.5 text-sm shadow-sm opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
                    {name}
                  </span>
                </Link>
              ) : null,
            )}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 py-20 lg:px-16">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <MotionAccordion items={faqItems} gap={0} />
        </div>
      </section>

      {/* AURORA */}
      <AuroraBarsClient
        maxHeightRatio={1}
        minHeightRatio={0.2}
        className="mx-auto mt-12 h-64"
        background="var(--background)"
        barCount={20}
        colors={[
          'color-mix(in srgb, var(--color-fd-primary), white 65%)',
          'var(--color-fd-primary)',
          'color-mix(in srgb, var(--color-fd-primary), black 15%)',
          'color-mix(in srgb, var(--color-fd-primary), black 35%)',
          '#00000000',
        ]}
        speed={2}
      />

      {/* FOOTER */}
      <section className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-6 py-16 text-center lg:px-16">
          <h2 className="max-w-xl text-xl font-bold text-fd-foreground sm:text-3xl">
            Stop reinventing the call layer.
          </h2>

          <div className={buttonGroupClass}>
            <Link href="/docs" className={primaryButtonClass}>
              Get started
            </Link>

            <a
              href="https://github.com/LakBud/vernLLM"
              target="_blank"
              rel="noreferrer"
              className={secondaryButtonClass}
            >
              Source
            </a>
          </div>

          <code className="font-mono text-xs text-fd-muted-foreground">npm install vern-llm</code>
        </div>
      </section>
    </div>
  );
}
