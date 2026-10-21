import type {
  BreakerEntry,
  CallLogRecord,
  ErrorGroupEntry,
  LogEntry,
  SummaryEntry,
} from '../../types/index.js';

const seconds = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

/** `type`, or `type/code` when the error has a code. */
const errorLabel = ({ type, code }: { type: string; code?: string | undefined }): string =>
  code ? `${type}/${code}` : type;

function describeCall(entry: CallLogRecord): string {
  const target = entry.provider ? ` ${entry.provider}/${entry.model}` : '';
  const parts = [`${entry.outcome}${target}`, seconds(entry.durationMs)];
  if (entry.ttftMs !== undefined) parts.push(`ttft ${seconds(entry.ttftMs)}`);
  if (entry.cache) parts.push(`cache ${entry.cache}`);
  else if (entry.attempts !== 1) parts.push(`${entry.attempts} attempts`);
  if (entry.reason) parts.push(entry.reason);
  if (entry.error) parts.push(errorLabel(entry.error));
  parts.push(entry.requestId);
  return parts.join(' ');
}

function describeErrorGroup(entry: ErrorGroupEntry): string {
  return `error_group ${entry.provider} ${errorLabel(entry)} x${entry.count} in ${seconds(entry.windowMs)}`;
}

function describeBreaker(entry: BreakerEntry): string {
  return `breaker ${entry.provider}/${entry.model} ${entry.from} -> ${entry.to}`;
}

function describeSummary({ series }: SummaryEntry): string {
  const dims = Object.values(series.dimensions).join('/') || 'all';
  const p99 = series.quantiles['0.99'];
  const tail = p99 === undefined ? '' : ` p99 ${seconds(p99)}`;
  return `summary ${series.metric} ${dims} n=${series.count}${tail} errors ${series.errors}`;
}

/** One readable line for an entry, without the sink's own prefix. */
export function describeEntry(entry: LogEntry): string {
  switch (entry.kind) {
    case 'call':
      return describeCall(entry);
    case 'error_group':
      return describeErrorGroup(entry);
    case 'breaker':
      return describeBreaker(entry);
    case 'summary':
      return describeSummary(entry);
  }
}
