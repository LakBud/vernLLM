import { Trophy } from 'lucide-react';

export type VerdictLevel = 'strong' | 'partial' | 'limited';

export interface VerdictCell {
  level: VerdictLevel;
  /** One short line shown under the level. */
  detail?: string;
}

export interface VerdictRow {
  pillar: string;
  /** Must match one of `tools`. */
  best: string;
  why: string;
  /** Optional caveat, such as where another tool leads. */
  note?: string;
  cells: Record<string, VerdictCell>;
}

export interface PillarVerdictProps {
  tools: string[];
  rows: VerdictRow[];
}

const LEVELS: Record<VerdictLevel, { label: string; filled: number }> = {
  strong: { label: 'Strong', filled: 3 },
  partial: { label: 'Partial', filled: 2 },
  limited: { label: 'Limited', filled: 1 },
};

function Dots({ level }: { level: VerdictLevel }) {
  const { filled } = LEVELS[level];
  return (
    <span aria-hidden="true" className="inline-flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={
            i < filled
              ? 'size-2 rounded-full bg-fd-primary'
              : 'size-2 rounded-full border border-fd-border'
          }
        />
      ))}
    </span>
  );
}

export function PillarVerdict({ tools, rows }: PillarVerdictProps) {
  for (const row of rows) {
    if (!tools.includes(row.best)) {
      throw new Error(`PillarVerdict: best "${row.best}" in "${row.pillar}" is not a listed tool`);
    }
  }

  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-fd-border bg-fd-card">
      <table className="w-full min-w-160 border-collapse text-sm">
        <thead>
          <tr className="border-b border-fd-border text-left">
            <th scope="col" className="p-3 font-medium">
              Pillar
            </th>
            {tools.map((tool) => (
              <th key={tool} scope="col" className="p-3 font-medium">
                {tool}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.pillar} className="border-b border-fd-border align-top last:border-b-0">
              <th scope="row" className="w-56 p-3 text-left font-normal">
                <div className="font-semibold">{row.pillar}</div>
                <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-fd-primary/15 px-2 py-0.5 text-xs font-medium text-fd-primary">
                  <Trophy aria-hidden="true" className="size-3" />
                  Best: {row.best}
                </div>
                <p className="mt-2 text-xs text-fd-muted-foreground">{row.why}</p>
                {row.note ? (
                  <p className="mt-1 text-xs text-fd-muted-foreground italic">{row.note}</p>
                ) : null}
              </th>
              {tools.map((tool) => {
                const cell = row.cells[tool];
                const isBest = tool === row.best;
                return (
                  <td
                    key={tool}
                    data-best={isBest || undefined}
                    className={isBest ? 'bg-fd-primary/5 p-3' : 'p-3'}
                  >
                    {cell ? (
                      <>
                        <span
                          className="inline-flex items-center gap-2 font-medium"
                          aria-label={`${tool}: ${LEVELS[cell.level].label}`}
                        >
                          <Dots level={cell.level} />
                          {LEVELS[cell.level].label}
                        </span>
                        {cell.detail ? (
                          <p className="mt-1 text-xs text-fd-muted-foreground">{cell.detail}</p>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-fd-muted-foreground">Not rated</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
