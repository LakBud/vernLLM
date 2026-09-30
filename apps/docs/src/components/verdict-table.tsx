import { cva } from 'class-variance-authority';
import { Trophy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const LEVELS = {
  excellent: { label: 'Excellent', filled: 5 },
  strong: { label: 'Strong', filled: 4 },
  good: { label: 'Good', filled: 3 },
  partial: { label: 'Partial', filled: 2 },
  limited: { label: 'Limited', filled: 1 },
  none: { label: 'None found', filled: 0 },
  na: { label: 'Not applicable', filled: 0 },
} as const;

export type VerdictLevel = keyof typeof LEVELS;

/** Segments in the meter, one per graded stage from Limited to Excellent. */
const STAGES = [0, 1, 2, 3, 4];

/** Where a capability runs when it isn't in the client library itself. */
export type VerdictVia = 'gateway' | 'proxy' | 'hosted' | 'redis';

const VIA_LABELS: Record<VerdictVia, string> = {
  gateway: 'Gateway',
  proxy: 'Proxy',
  hosted: 'Hosted',
  redis: 'Redis',
};

const segmentVariants = cva('h-1.5 w-3 rounded-full', {
  variants: {
    tone: {
      on: 'bg-fd-primary',
      off: 'bg-fd-muted',
    },
  },
});

const levelTextVariants = cva('text-sm font-medium', {
  variants: {
    level: {
      excellent: 'text-fd-primary',
      strong: 'text-fd-foreground',
      good: 'text-fd-foreground',
      partial: 'text-fd-foreground',
      limited: 'text-fd-muted-foreground',
      none: 'text-fd-muted-foreground',
      na: 'text-fd-muted-foreground italic',
    },
  },
});

export interface VerdictCell {
  level: VerdictLevel;
  /** Replaces the level's label, such as "By design" or "Bring your own". */
  label?: string;
  /** One short line shown under the level. */
  detail?: string;
  via?: VerdictVia;
}

export interface VerdictRow {
  label: string;
  /** One or more of `tools`. Leave out when no tool stands out. */
  best?: string | string[];
  why?: string;
  note?: string;
  cells: Record<string, VerdictCell>;
}

export interface VerdictTableProps {
  tools: string[];
  rows: VerdictRow[];
  /** Header of the first column. Default `'Area'`. */
  rowHeader?: string;
  className?: string;
}

function bestOf(row: VerdictRow): string[] {
  if (row.best === undefined) return [];
  return Array.isArray(row.best) ? row.best : [row.best];
}

function LevelMeter({ level }: { level: VerdictLevel }) {
  const { filled } = LEVELS[level];
  return (
    <span aria-hidden="true" data-slot="verdict-meter" className="inline-flex gap-0.5">
      {STAGES.map((i) => (
        <span key={i} className={segmentVariants({ tone: i < filled ? 'on' : 'off' })} />
      ))}
    </span>
  );
}

function Cell({ tool, cell }: { tool: string; cell: VerdictCell | undefined }) {
  if (!cell) return <span className="text-sm text-fd-muted-foreground">Not rated</span>;
  const text = cell.label ?? LEVELS[cell.level].label;
  return (
    <div className="flex flex-col gap-1.5">
      <LevelMeter level={cell.level} />
      <span
        data-slot="verdict-level"
        data-level={cell.level}
        aria-label={`${tool}: ${text}`}
        className={levelTextVariants({ level: cell.level })}
      >
        {text}
      </span>
      {cell.detail ? <p className="text-xs text-fd-muted-foreground">{cell.detail}</p> : null}
      {cell.via ? (
        <Badge variant="outline" className="mt-0.5">
          {VIA_LABELS[cell.via]}
        </Badge>
      ) : null}
    </div>
  );
}

export function VerdictTable({ tools, rows, rowHeader = 'Area', className }: VerdictTableProps) {
  for (const row of rows) {
    for (const best of bestOf(row)) {
      if (!tools.includes(best)) {
        throw new Error(`VerdictTable: best "${best}" in "${row.label}" is not a listed tool`);
      }
    }
  }

  return (
    <div
      data-slot="verdict-table"
      className={cn(
        'not-prose my-6 overflow-x-auto rounded-xl border border-fd-border bg-fd-card',
        className,
      )}
    >
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-fd-border text-left">
            <th scope="col" className="p-3 font-medium text-fd-muted-foreground">
              {rowHeader}
            </th>
            {tools.map((tool) => (
              <th key={tool} scope="col" className="p-3 font-semibold">
                {tool}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const best = bestOf(row);
            return (
              <tr key={row.label} className="border-b border-fd-border align-top last:border-b-0">
                <th scope="row" className="w-52 p-3 text-left font-normal">
                  <div className="font-semibold">{row.label}</div>
                  {best.length > 0 ? (
                    <Badge className="mt-1.5">
                      <Trophy data-icon="inline-start" aria-hidden="true" />
                      {best.length > 1 ? `Tie: ${best.join(', ')}` : `Best: ${best[0]}`}
                    </Badge>
                  ) : null}
                  {row.why ? (
                    <p className="mt-2 text-xs text-fd-muted-foreground">{row.why}</p>
                  ) : null}
                  {row.note ? (
                    <p className="mt-1 text-xs text-fd-muted-foreground italic">{row.note}</p>
                  ) : null}
                </th>
                {tools.map((tool) => {
                  const isBest = best.includes(tool);
                  return (
                    <td
                      key={tool}
                      data-best={isBest || undefined}
                      className={cn('p-3', isBest && 'bg-fd-primary/5')}
                    >
                      <Cell tool={tool} cell={row.cells[tool]} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
