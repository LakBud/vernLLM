import { LLMError, type WireCallRequest } from 'vern-llm';

import {
  assertForcedToolChoiceSupported,
  rejectsForcedToolChoice,
  supportsNativeStructuredOutput,
  unsupportedCapability,
  type ModelCapabilityOverride,
} from './capabilities.js';

type WireJsonSchema = Extract<
  NonNullable<WireCallRequest['response_format']>,
  { type: 'json_schema' }
>['json_schema'];

/**
 * How `jsonSchema` is sent: not at all, as native structured output, or as a
 * forced call to a tool named `schemaName`, the trimmed schema name.
 */
export type StructuredOutputPlan =
  | { mode: 'none' }
  | { mode: 'native'; jsonSchema: WireJsonSchema; schemaName: string }
  | { mode: 'forcedTool'; jsonSchema: WireJsonSchema; schemaName: string };

/**
 * Checks `jsonSchema`, `tools` and `tool_choice` against the model and picks
 * how structured output is sent. A model that rejects a forced `tool_choice`
 * can't run the forced tool emulation, so native output is its only working
 * path. Throws before dispatch for a request the model can't serve.
 */
export function planStructuredOutput(
  params: WireCallRequest,
  models: {
    nativeStructuredOutputModels?: ModelCapabilityOverride;
    forcedToolChoiceUnsupportedModels?: ModelCapabilityOverride;
  },
  messages: { toolsWithJsonSchema: (model: string) => string; jsonObject: string },
): StructuredOutputPlan {
  const jsonSchema =
    params.response_format?.type === 'json_schema' ? params.response_format.json_schema : undefined;
  const schemaName = jsonSchema?.name.trim();

  if (jsonSchema && !schemaName) {
    throw new LLMError('json_schema.name must not be empty.', 'validation');
  }

  const rejectsForced = rejectsForcedToolChoice(
    params.model,
    models.forcedToolChoiceUnsupportedModels,
  );

  if (params.tools?.length) {
    assertForcedToolChoiceSupported(
      params.model,
      params.tool_choice,
      models.forcedToolChoiceUnsupportedModels,
    );
  }

  const isNative =
    Boolean(jsonSchema) &&
    (rejectsForced ||
      supportsNativeStructuredOutput(params.model, models.nativeStructuredOutputModels));

  if (jsonSchema && params.tools?.length && !isNative) {
    throw unsupportedCapability(
      messages.toolsWithJsonSchema(params.model),
      'tools_with_json_schema',
    );
  }

  if (params.response_format?.type === 'json_object') {
    throw new LLMError(messages.jsonObject, 'validation');
  }

  if (!jsonSchema || !schemaName) return { mode: 'none' };
  return { mode: isNative ? 'native' : 'forcedTool', jsonSchema, schemaName };
}

/**
 * Throws `LLMError('validation')` when the model never called the forced
 * json_schema tool at all: it ignored it, called a different tool, or
 * replied with plain text instead.
 */
export function throwMissingForcedJsonSchemaTool(toolName: string): never {
  throw new LLMError(
    `Bedrock did not return the required structured output tool "${toolName}".`,
    'validation',
  );
}

/**
 * Throws `LLMError('validation')` when the forced tool's parsed `input`
 * isn't a JSON object. Only the non streaming path has a parsed value to check.
 */
export function assertForcedJsonSchemaToolInputIsObject(
  toolName: string,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LLMError(
      `Bedrock returned invalid structured output for tool "${toolName}". Expected an object.`,
      'validation',
    );
  }
}
