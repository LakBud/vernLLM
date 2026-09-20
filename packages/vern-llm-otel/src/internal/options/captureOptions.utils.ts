import { optionalBoolean, optionalFunction } from './validate.utils.js';

import type { CaptureContentOptions } from '../../types/index.js';
import type { ResolvedCapture } from './resolvedConfig.js';

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

  // Not `??`: an explicit null is a mistake to report, not a request for the default.
  const maxLength = c.maxLength === undefined ? DEFAULT_MAX_LENGTH : c.maxLength;
  const validLength =
    typeof maxLength === 'number' &&
    (maxLength === Number.POSITIVE_INFINITY || (Number.isInteger(maxLength) && maxLength > 0));
  if (!validLength) {
    throw new Error(
      'otelMiddleware: captureContent.maxLength must be a positive integer or Infinity',
    );
  }

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
