'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { motion, useAnimationFrame, useMotionValue } from 'motion/react';

interface Command {
  manager: string;
  verb: string;
}

const COMMANDS: Command[] = [
  { manager: 'npm', verb: 'install' },
  { manager: 'pnpm', verb: 'add' },
  { manager: 'yarn', verb: 'add' },
  { manager: 'bun', verb: 'add' },
];

// Reuses the same token palette the code block's syntax highlighting uses,
// so this stays in sync with the theme (including light/dark) automatically.
const COLORS = {
  manager: 'var(--shiki-token-function)',
  verb: 'var(--shiki-token-keyword)',
  pkg: 'var(--shiki-gold)',
};

function CommandLine({ manager, verb }: Command) {
  return (
    <code className="flex items-center whitespace-nowrap">
      <span className="mr-2 text-fd-muted-foreground">$</span>
      <span style={{ color: COLORS.manager }}>{manager}</span>
      <span>&nbsp;</span>
      <span style={{ color: COLORS.verb }}>{verb}</span>
      <span>&nbsp;</span>
      <span style={{ color: COLORS.pkg }}>vern-llm</span>
    </code>
  );
}

// Repeated enough times to comfortably overflow any viewport width. This
// single block (HALF) is measured in real pixels and rendered twice back
// to back, and the track is driven continuously frame by frame with the
// x offset wrapped modulo that measured pixel width. There is no
// keyframe restart to snap on, so there is nothing to desync, no matter
// what the browser measures the block's rendered width as.
const HALF = [...COMMANDS, ...COMMANDS, ...COMMANDS, ...COMMANDS];

const SPEED_PX_PER_SEC = 40;

export function InstallCommand() {
  const blockARef = useRef<HTMLDivElement>(null);
  const blockBRef = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(0);
  const x = useMotionValue(0);

  useLayoutEffect(() => {
    const measure = () => {
      // offsetLeft reflects untransformed layout position regardless of
      // the current CSS transform, so this stays exact even mid-scroll.
      // This is the real distance from block A's start to block B's
      // start, including the flex gap between them, not just block A's
      // own rendered width, which was the source of the seam nudge.
      if (blockARef.current && blockBRef.current) {
        setWrapWidth(blockBRef.current.offsetLeft - blockARef.current.offsetLeft);
      }
    };
    measure();

    const ro = new ResizeObserver(measure);
    if (blockARef.current) ro.observe(blockARef.current);

    // Fonts finishing their swap after mount can change measured text
    // width; re-measure once that settles so the wrap point stays exact.
    document.fonts?.ready.then(measure).catch(() => {});

    return () => ro.disconnect();
  }, []);

  useAnimationFrame((_, delta) => {
    if (wrapWidth <= 0) return;
    let next = x.get() - (SPEED_PX_PER_SEC * delta) / 1000;
    // Once we've scrolled past exactly the block-to-block distance, add
    // that same distance back. The two rendered copies are identical, so
    // this keeps the visible content continuous, no snap, no drift.
    if (next <= -wrapWidth) next += wrapWidth;
    x.set(next);
  });

  return (
    <div className="relative w-full min-w-0 max-w-full overflow-hidden">
      <motion.div className="flex w-max items-center gap-16 font-mono text-sm" style={{ x }}>
        <div ref={blockARef} className="flex items-center gap-16">
          {HALF.map((cmd, i) => (
            <CommandLine key={`a-${cmd.manager}-${i}`} {...cmd} />
          ))}
        </div>
        <div ref={blockBRef} className="flex items-center gap-16" aria-hidden="true">
          {HALF.map((cmd, i) => (
            <CommandLine key={`b-${cmd.manager}-${i}`} {...cmd} />
          ))}
        </div>
      </motion.div>

      <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-linear-to-r from-fd-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-linear-to-l from-fd-background to-transparent" />
    </div>
  );
}
