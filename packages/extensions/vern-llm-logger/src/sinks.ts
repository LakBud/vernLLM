import type { LogEntry, LogLevel, LogSink } from './types/index.js';

export interface JsonSinkOptions {
  /** Receives one JSON line per entry. Default `console.log`, which works on every runtime. */
  write?: (line: string) => void;
}

/** One JSON line per entry, ready for any log shipper. */
export function jsonSink(options: JsonSinkOptions = {}): LogSink {
  const write = options.write ?? ((line: string) => console.log(line));
  return { write: (_level, entry) => write(JSON.stringify(entry)) };
}

export interface ConsoleSinkOptions {
  /** Receives one readable line. Default is the `console` method for the level. */
  write?: (line: string, level: LogLevel) => void;
}

const seconds = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

function describeEntry(entry: LogEntry): string {
  switch (entry.kind) {
    case 'call': {
      const target = entry.provider ? ` ${entry.provider}/${entry.model}` : '';
      const parts = [`${entry.outcome}${target}`, seconds(entry.durationMs)];
      if (entry.ttftMs !== undefined) parts.push(`ttft ${seconds(entry.ttftMs)}`);
      if (entry.cache) parts.push(`cache ${entry.cache}`);
      else if (entry.attempts !== 1) parts.push(`${entry.attempts} attempts`);
      if (entry.reason) parts.push(entry.reason);
      if (entry.error)
        parts.push(`${entry.error.type}${entry.error.code ? `/${entry.error.code}` : ''}`);
      parts.push(entry.requestId);
      return parts.join(' ');
    }
    case 'error_group':
      return `error_group ${entry.provider} ${entry.type}${entry.code ? `/${entry.code}` : ''} x${entry.count} in ${seconds(entry.windowMs)}`;
    case 'breaker':
      return `breaker ${entry.provider}/${entry.model} ${entry.from} -> ${entry.to}`;
    case 'summary': {
      const { series } = entry;
      const dims = Object.values(series.dimensions).join('/') || 'all';
      const p99 = series.quantiles['0.99'];
      return `summary ${series.metric} ${dims} n=${series.count}${p99 === undefined ? '' : ` p99 ${seconds(p99)}`} errors ${series.errors}`;
    }
  }
}

/** One readable line per entry, for a terminal. */
export function consoleSink(options: ConsoleSinkOptions = {}): LogSink {
  const write =
    options.write ??
    ((line: string, level: LogLevel) => {
      const method = level === 'info' ? 'log' : level;
      console[method](line);
    });
  return { write: (level, entry) => write(`[VernLLM] ${describeEntry(entry)}`, level) };
}

export interface MemorySink extends LogSink {
  /** Everything written so far, in order, with the level it was written at. */
  readonly entries: ReadonlyArray<{ level: LogLevel; entry: LogEntry }>;
  clear(): void;
}

/** Keeps entries in an array. The main tool in tests. */
export function memorySink(): MemorySink {
  const entries: Array<{ level: LogLevel; entry: LogEntry }> = [];
  return {
    entries,
    write: (level, entry) => {
      entries.push({ level, entry });
    },
    clear: () => {
      entries.length = 0;
    },
  };
}
