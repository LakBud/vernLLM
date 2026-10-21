import { defaultEstimateTokens, type WireCallRequest } from 'vern-llm';

/** Tokens of `value` as JSON, at four characters a token. */
function jsonTokens(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Math.ceil((JSON.stringify(value)?.length ?? 0) / 4);
  } catch {
    return 0;
  }
}

/** The most tokens a request could use. Tools and the response schema count as input. */
export function estimateRequestTokens(request: Readonly<WireCallRequest>): {
  total: number;
  input: number;
  output: number;
} {
  const base = defaultEstimateTokens(request);
  const schemas = jsonTokens(request.tools) + jsonTokens(request.response_format);
  const total = base + schemas;
  const output = Math.min(Math.max(0, request.max_tokens), base);
  return { total, input: total - output, output };
}

/** Output tokens of an answer in hand, at four characters a token. */
export function estimateAnswerTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Math.ceil(text.length / 4);
}
