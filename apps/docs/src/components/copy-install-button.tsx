'use client';

import { useEffect, useRef, useState } from 'react';

import { Check, Copy } from 'lucide-react';

const COMMAND = 'npm i vern-llm';

// Same shiki tokens as the install marquee, so light and dark stay in sync.
const COLORS = {
  manager: 'var(--shiki-token-function)',
  verb: 'var(--shiki-token-keyword)',
  pkg: 'var(--shiki-gold)',
};

export function CopyInstallButton() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied to clipboard' : `Copy ${COMMAND}`}
      className="group inline-flex cursor-pointer items-center gap-2 rounded-md border border-fd-border bg-(--shiki-background) px-3 py-1.5 font-mono text-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-fd-primary  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-primary active:translate-y-0"
    >
      <span className="text-fd-muted-foreground">$</span>
      <span>
        <span style={{ color: COLORS.manager }}>npm</span>{' '}
        <span style={{ color: COLORS.verb }}>i</span>{' '}
        <span style={{ color: COLORS.pkg }}>vern-llm</span>
      </span>
      <Icon
        aria-hidden="true"
        className="size-3.5 text-fd-muted-foreground transition-colors group-hover:text-fd-primary"
      />
    </button>
  );
}
