import { describeEntry } from './internal/sinks/describeEntry.utils.js';

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
