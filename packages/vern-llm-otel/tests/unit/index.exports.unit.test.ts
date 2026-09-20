import { describe, expect, it } from 'vitest';

import * as entry from '../../src/index.js';
import {
  otelMiddleware,
  otelMiddlewareRef,
  type CaptureContentOptions,
  type GenAiProviderName,
  type OtelMiddlewareOptions,
  type RecordExceptionsOptions,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports exactly the documented runtime surface', () => {
    // An exact list, so an internal helper can never become public by accident.
    expect(Object.keys(entry).sort()).toEqual(['otelMiddleware', 'otelMiddlewareRef']);
  });

  it('exports the factory and the ref', () => {
    expect(typeof otelMiddleware).toBe('function');
    expect(otelMiddlewareRef).toBeDefined();
    expect(otelMiddlewareRef.debugName).toBe('otel');
  });

  it('exports the option types, usable together as documented', () => {
    const capture: CaptureContentOptions = {
      input: true,
      output: true,
      systemInstructions: true,
      toolDefinitions: false,
      maxLength: 4096,
      redact: (text) => text,
      when: () => true,
    };
    const exceptions: RecordExceptionsOptions = { stack: false };
    const provider: GenAiProviderName = 'my.gateway';
    const known: GenAiProviderName = 'openai';

    const options: OtelMiddlewareOptions = {
      providerNames: { primary: provider, 'fallback[0]': known },
      metrics: true,
      genAiConventions: true,
      captureContent: capture,
      middlewareEvents: false,
      recordExceptions: exceptions,
      logger: 'silent',
      name: 'otel',
      priority: -1000,
      runsAfter: [],
    };

    expect(otelMiddleware(options).name).toBe('otel');
  });
});
