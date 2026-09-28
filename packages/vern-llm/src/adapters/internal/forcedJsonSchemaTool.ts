import { LLMError } from '../../types/index.js';

// Shared by adapters that emulate `jsonSchema` as a forced single tool call,
// so the errors read the same across providers and entry points.

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
 * Throws `LLMError('validation')` when the forced tool's parsed `input`
 * isn't a JSON object. Only non-streaming paths have a parsed value to check.
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
