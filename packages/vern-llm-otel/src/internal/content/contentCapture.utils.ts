import { ATTR } from '../semconv.js';
import { decideCapture } from './decideCapture.utils.js';
import { serializeInput } from './serializeInput.utils.js';
import { serializeOutput } from './serializeOutput.utils.js';

import type { ContentCapture, ResolvedCapture } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { Attributes } from '@opentelemetry/api';

// Content is opt in and can hold personal data, so every decision here fails closed: when
// something cannot be checked, redacted, or serialized, that piece is left out.

export function createContentCapture(capture: ResolvedCapture, guard: Guard): ContentCapture {
  return {
    decide: (ctx, request, span) => decideCapture(capture, ctx, request, span, guard),

    captureInput(span, request) {
      // Checked on the span being written to, because a custom sampler can decide differently
      // for the call span and each attempt span.
      if (!span.isRecording()) return;

      const input = serializeInput(request, capture, guard);
      const attributes: Attributes = {};
      if (input.inputMessages !== undefined) attributes[ATTR.inputMessages] = input.inputMessages;
      if (input.systemInstructions !== undefined) {
        attributes[ATTR.systemInstructions] = input.systemInstructions;
      }
      if (input.toolDefinitions !== undefined)
        attributes[ATTR.toolDefinitions] = input.toolDefinitions;

      span.setAttributes(attributes);
    },

    captureOutput(span, value) {
      if (!capture.output || !span.isRecording()) return;

      const output = serializeOutput(value, capture, guard);
      if (output !== undefined) span.setAttribute(ATTR.outputMessages, output);
    },
  };
}
