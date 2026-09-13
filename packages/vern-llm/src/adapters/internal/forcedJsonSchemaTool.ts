import { LLMError } from '../../types/index.js';

/**
 * Shared validation for adapters that emulate `response_format:
 * 'json_schema'` by forcing the model to call a single synthetic tool,
 * rather than using a provider's native structured-output field
 * (`fromAnthropic`'s legacy path, `fromBedrock`'s legacy `jsonSchema`
 * path; see each adapter's `nativeStructuredOutputModels` option for the
 * native alternative). Providers with only a native path (Gemini,
 * OpenAI-compatible) never force a tool this way and have no use for
 * these.
 *
 * Centralized so wording can't drift between providers, or between one
 * adapter's own `create` and `createStream` entry points, the way it
 * already had before this was extracted (`fromBedrock`'s `create()`
 * silently returned empty content on a missing tool while
 * `fromAnthropic` threw, for the identical scenario).
 */

/**
 * Throws `LLMError('validation')` when the model never called the forced
 * json_schema tool at all (ignored it, called a different tool, or
 * replied with plain text instead).
 */
export function throwMissingForcedJsonSchemaTool(provider: string, toolName: string): never {
  throw new LLMError(
    `${provider} did not return the required structured output tool "${toolName}".`,
    'validation',
  );
}

/**
 * Throws `LLMError('validation')` when the forced tool's `input` isn't a
 * JSON object, narrowing the type on return so callers can `JSON.stringify`
 * it without a further check.
 *
 * Only relevant to non-streaming `create()` paths, where a provider hands
 * back an already-parsed `input` value. Streaming paths accumulate the
 * tool's raw JSON text deltas instead of a parsed value, so there's
 * nothing to shape-check until the caller parses the accumulated string
 * themselves.
 */
export function assertForcedJsonSchemaToolInputIsObject(
  provider: string,
  toolName: string,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LLMError(
      `${provider} returned invalid structured output for tool "${toolName}". Expected an object.`,
      'validation',
    );
  }
}
