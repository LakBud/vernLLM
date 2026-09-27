import { toTokenUsage, type TokenUsageMeta } from '../response/usage.utils.js';
import { createToolCallAccumulator } from './toolCallAccumulator.utils.js';

import type {
  StreamChunk,
  ThinkingBlock,
  TokenUsage,
  WireStreamChunk,
  WireToolCall,
} from '../../../../types/index.js';
import type { ProviderRateLimitHint } from '../../../utils/rate-limit/rateLimitHint.utils.js';

export interface StreamAccumulation {
  /** Folds one wire chunk in. Returns the push's space promise when a chunk reached the caller. */
  apply: (chunk: WireStreamChunk) => Promise<void> | undefined;
  readonly usage: TokenUsage | undefined;
  /** What `finalize` receives once the stream ends. */
  result: () => {
    text: string;
    wireToolCalls: WireToolCall[] | undefined;
    usage: TokenUsage | undefined;
    thinking: ThinkingBlock[] | undefined;
  };
}

/**
 * Collects text, tool calls, usage and thinking from wire chunks and forwards
 * caller visible chunks through `push`. Pings and hints push nothing, and
 * thinking stays in the result only.
 */
export function createStreamAccumulation(
  usageMeta: TokenUsageMeta,
  push: (chunk: StreamChunk) => Promise<void> | undefined,
  onRateLimitHint?: (hint: ProviderRateLimitHint) => void,
): StreamAccumulation {
  const toolCalls = createToolCallAccumulator();
  const thinking: ThinkingBlock[] = [];
  let text = '';
  let usage: TokenUsage | undefined;

  return {
    apply(chunk) {
      switch (chunk.type) {
        case 'rate_limit_hint':
          // Fired right away, not deferred to the end.
          onRateLimitHint?.(chunk.hint);
          return undefined;
        case 'text-delta':
          text += chunk.delta;
          return push({ type: 'text-delta', delta: chunk.delta });
        case 'tool_call_delta':
          return push(toolCalls.apply(chunk));
        case 'thinking_block':
          thinking.push(chunk.block);
          return undefined;
        case 'usage':
          usage = toTokenUsage(chunk.usage, usageMeta);
          return push({ type: 'usage', usage });
        default:
          // A ping only resets the idle clock on the next read.
          return undefined;
      }
    },
    get usage() {
      return usage;
    },
    result: () => ({
      text,
      wireToolCalls: toolCalls.toWireToolCalls(),
      usage,
      thinking: thinking.length ? thinking : undefined,
    }),
  };
}
