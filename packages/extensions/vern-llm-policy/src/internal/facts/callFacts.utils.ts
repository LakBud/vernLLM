import { defaultEstimateTokens, type PreDispatchContext, type WireCallRequest } from 'vern-llm';

import { readOnly } from './readOnly.utils.js';

import type { CallFacts } from '../../types/options.js';
import type { PolicyNeeds } from '../../types/resolvedConfig.js';

function hasImages(request: Readonly<WireCallRequest>): boolean {
  return request.messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'image'),
  );
}

/** What a `when` pattern sees. Costly facts are computed only when a rule reads them. */
export function callFacts(
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  needs: Readonly<PolicyNeeds>,
  labels?: readonly string[],
): CallFacts {
  return Object.freeze({
    ...(ctx.context !== undefined && {
      context: needs.functions ? readOnly(ctx.context) : ctx.context,
    }),
    ...(labels !== undefined && { labels }),
    request: Object.freeze({
      hasTools: (request.tools?.length ?? 0) > 0,
      jsonOutput: request.response_format !== undefined,
      images: needs.images && hasImages(request),
      // The estimate adds the reply budget, which is not input.
      inputTokens: needs.inputTokens ? defaultEstimateTokens({ ...request, max_tokens: 0 }) : 0,
      streaming: ctx.streaming === true,
    }),
    callTargets: ctx.callTargets !== undefined,
  });
}
