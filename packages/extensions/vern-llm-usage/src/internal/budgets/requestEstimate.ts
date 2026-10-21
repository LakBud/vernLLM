import { defaultEstimateTokens, type WireCallRequest } from 'vern-llm';

/**
 * The tokens a request could use. `defaultEstimateTokens` already includes `max_tokens`, so the
 * input is what is left of it, and adding `max_tokens` again would count it twice.
 */
export function estimateRequestTokens(request: Readonly<WireCallRequest>): {
  total: number;
  input: number;
  output: number;
} {
  const total = defaultEstimateTokens(request);
  const output = Math.min(Math.max(0, request.max_tokens), total);
  return { total, input: total - output, output };
}

/**
 * Output tokens of an answer already in hand, at the same four characters a token that
 * `defaultEstimateTokens` uses. A string counts as it is, anything else as its JSON.
 */
export function estimateAnswerTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Math.ceil(text.length / 4);
}
