import { jsonSink } from '../../sinks.js';
import { fail, isPlainObject } from './validate.utils.js';

import type { LoggerMiddlewareOptions, LogLevel, LogSink } from '../../types/index.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function normalizeSink(value: LoggerMiddlewareOptions['sink']): LogSink {
  // Not `??`: an explicit `null` is a mistake to report, not a request for the default.
  const sink = value === undefined ? jsonSink() : value;
  if (!isPlainObject(sink) || typeof sink.write !== 'function') {
    fail('sink must be an object with a write function');
  }
  return sink;
}

export function normalizeLevel(value: LoggerMiddlewareOptions['level']): LogLevel {
  const level = value === undefined ? 'info' : value;
  if (!LEVELS.includes(level)) fail(`level must be one of ${LEVELS.join(', ')}`);
  return level;
}
