import { describe, expect, it } from 'vitest';

import * as entry from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports exactly the documented runtime surface', () => {
    // An exact list, so an internal helper can never become public by accident.
    expect(Object.keys(entry).sort()).toEqual([
      'consoleSink',
      'fromEvent',
      'jsonSink',
      'loggerMiddleware',
      'loggerMiddlewareRef',
      'memorySink',
    ]);
  });

  it('names the ref after the package', () => {
    expect(entry.loggerMiddlewareRef.debugName).toBe('logger');
  });

  it('exports the entry and option types, usable together as documented', () => {
    const options: entry.LoggerMiddlewareOptions = {
      sink: entry.memorySink(),
      customEvents: { defaults: false, names: ['myapp.*'] },
      dimensions: { tier: (record: entry.CallLogRecord) => record.context?.tier as string },
      enrich: [() => ({ traceId: 'abc' })],
    };
    const levels: entry.LogLevel[] = ['debug', 'info', 'warn', 'error'];

    expect(entry.loggerMiddleware(options).name).toBe('logger');
    expect(levels).toHaveLength(4);
  });
});
