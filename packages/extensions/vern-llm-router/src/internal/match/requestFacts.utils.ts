import { defaultEstimateTokens, type WireCallRequest } from 'vern-llm';

/** What routes and capabilities ask of a request, read once per call. */
export interface RequestFacts {
  readonly hasTools: boolean;
  readonly jsonOutput: boolean;
  readonly jsonSchema: boolean;
  readonly images: boolean;
  readonly maxTokens: number;
  /** Estimated input tokens, without the reserved output. Computed on first read. */
  readonly inputTokens: number;
}

function hasImage(request: Readonly<WireCallRequest>): boolean {
  return request.messages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => (block as { type?: string }).type === 'image'),
  );
}

export function createRequestFacts(request: Readonly<WireCallRequest>): RequestFacts {
  let inputTokens: number | undefined;

  return {
    hasTools: (request.tools?.length ?? 0) > 0,
    jsonOutput: request.response_format !== undefined,
    jsonSchema: request.response_format?.type === 'json_schema',
    images: hasImage(request),
    maxTokens: request.max_tokens,
    get inputTokens(): number {
      inputTokens ??= Math.max(0, defaultEstimateTokens(request as never) - request.max_tokens);
      return inputTokens;
    },
  };
}
