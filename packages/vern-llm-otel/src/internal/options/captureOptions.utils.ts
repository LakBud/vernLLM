import { optionalBoolean, optionalFunction, resolveMaxLength } from './validate.utils.js';

import type { CaptureContentOptions, ResolvedCapture } from '../../types/index.js';

export const DEFAULT_MAX_LENGTH = 8192;

export function normalizeCapture(
  option: boolean | CaptureContentOptions | undefined,
): ResolvedCapture | undefined {
  if (option === undefined || option === false) return undefined;

  if (option !== true && (typeof option !== 'object' || option === null || Array.isArray(option))) {
    throw new Error('otelMiddleware: captureContent must be a boolean or an object');
  }

  const c: CaptureContentOptions = option === true ? {} : option;

  optionalBoolean(c.input, 'captureContent.input');
  optionalBoolean(c.output, 'captureContent.output');
  optionalBoolean(c.systemInstructions, 'captureContent.systemInstructions');
  optionalBoolean(c.toolDefinitions, 'captureContent.toolDefinitions');
  optionalFunction(c.redact, 'captureContent.redact');
  optionalFunction(c.when, 'captureContent.when');

  const maxLength = resolveMaxLength(c.maxLength, 'captureContent.maxLength', DEFAULT_MAX_LENGTH);

  const resolved = {
    input: c.input ?? true,
    output: c.output ?? true,
    systemInstructions: c.systemInstructions ?? true,
    toolDefinitions: c.toolDefinitions ?? false,
  };

  return {
    ...resolved,
    maxLength,
    redact: c.redact,
    when: c.when,
    anyGroup: Object.values(resolved).some(Boolean),
  };
}
