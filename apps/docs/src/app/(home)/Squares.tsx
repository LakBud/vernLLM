'use client';

import { useEffect, useRef } from 'react';

interface SquaresProps {
  squareSize?: number;
  /** Chance per frame-tick that an idle cell trips into an active state */
  tripChance?: number;
}

type CellState = 'idle' | 'active';
type BreakerState = 'closed' | 'half-open' | 'open';

interface Cell {
  state: CellState;
  intensity: number; // 0–1
  breakerState: BreakerState;
}

function pickBreakerState(): BreakerState {
  const r = Math.random();
  if (r < 0.85) return 'closed';
  if (r < 0.97) return 'half-open';
  return 'open';
}

// Hardcoded directly off --color-fd-primary (37, 90%, 55%) — no runtime CSS
// parsing, so there's no chance of a hue mismatch depending on how the
// browser resolves the variable.
const COLORS = {
  border: 'hsla(212, 15%, 30%, 0.18)',
  closed: 'hsl(37, 35%, 40%)', // dim amber — quiet, most cells
  halfOpen: 'hsl(37, 65%, 50%)', // mid amber — probing
  open: 'hsl(37, 90%, 55%)', // full brand amber — tripped
};

const colorFor = (state: BreakerState) =>
  state === 'closed' ? COLORS.closed : state === 'half-open' ? COLORS.halfOpen : COLORS.open;

const withAlpha = (hslColor: string, alpha: number) =>
  hslColor.replace(/hsla?\(([^)]+)\)/, (_m, inner) => {
    const parts = inner.split(',').map((p: string) => p.trim());
    return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  });

export default function Squares({ squareSize = 48, tripChance = 0.00008 }: SquaresProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let cells: Cell[] = [];

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      cols = Math.ceil(canvas.width / squareSize) + 1;
      rows = Math.ceil(canvas.height / squareSize) + 1;
      cells = Array.from({ length: cols * rows }, () => ({
        state: 'idle',
        intensity: 0,
        breakerState: 'closed',
      }));
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const idx = j * cols + i;
          const cell = cells[idx];
          const x = i * squareSize;
          const y = j * squareSize;

          if (cell.state === 'idle' && Math.random() < tripChance) {
            cell.state = 'active';
            cell.intensity = 1;
            cell.breakerState = pickBreakerState();
          } else if (cell.state === 'active') {
            cell.intensity -= 0.008; // slower decay — a held blip, not a flash
            if (cell.intensity <= 0) {
              cell.state = 'idle';
              cell.intensity = 0;
            }
          }

          // Always-visible faint grid line
          ctx.strokeStyle = COLORS.border;
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, squareSize, squareSize);

          if (cell.intensity > 0) {
            const color = colorFor(cell.breakerState);
            ctx.fillStyle = withAlpha(color, cell.intensity * 0.18);
            ctx.fillRect(x, y, squareSize, squareSize);

            if (cell.intensity > 0.4) {
              ctx.strokeStyle = withAlpha(color, cell.intensity * 0.9);
              ctx.lineWidth = 1.5;
              ctx.strokeRect(x + 1, y + 1, squareSize - 2, squareSize - 2);
            }
          }
        }
      }

      raf.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf.current);
    };
  }, [squareSize, tripChance]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />;
}
