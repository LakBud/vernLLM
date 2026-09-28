import type { ModelCapabilityOverride } from './capabilities.js';
import type { EffortTokenTable } from './thinking.js';
import type { ConverseRequest } from '@aws-sdk/client-bedrock-runtime';
import type { WireCallRequest } from 'vern-llm';

/** The SDK's JSON document type, used for tool schemas, tool input and model fields. */
export type DocumentType = NonNullable<ConverseRequest['additionalModelRequestFields']>;

export type WireMessage = WireCallRequest['messages'][number];

/** Optional configuration for `fromBedrock`. */
export interface BedrockAdapterOptions {
  /**
   * Models known to support Converse tool use. When set, a `jsonSchema` call
   * that needs `toolConfig` on a model outside it throws
   * `LLMError('invalid_params')`, code `unsupported_capability`, before
   * dispatch. Unset, Bedrock's own error surfaces instead.
   */
  toolUseSupportedModels?: string[] | ((modelId: string) => boolean);
  /**
   * Models that support native structured output
   * (`outputConfig.textFormat`), which can be combined with real `tools`.
   * No default: other models emulate `jsonSchema` as a forced tool call.
   */
  nativeStructuredOutputModels?: ModelCapabilityOverride;
  /**
   * Overrides the token count each `reasoningEffort` tier maps onto. Omitted
   * tiers keep the default. Claude models only.
   */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Adds models that only accept adaptive thinking, on top of the built in
   * rule (Claude Opus 4.7 and later, every Claude 5 tier model).
   */
  adaptiveOnlyModels?: ModelCapabilityOverride;
  /**
   * Replaces the built in list of models that reject a forced `tool_choice`
   * (Claude Fable 5.1 and later, Opus 5.5 and later, every Claude major 6 and
   * later). On these, `toolChoice: 'required'` or `{ name }` throws
   * `unsupported_capability` before dispatch, and `jsonSchema` always uses
   * native structured output.
   */
  forcedToolChoiceUnsupportedModels?: ModelCapabilityOverride;
  /**
   * Adds models that are Claude but whose id doesn't say so, such as an
   * application inference profile ARN. Ids containing `claude` are always
   * treated as Claude. The version based rules can't read a nameless id, so
   * list these in `adaptiveOnlyModels` and `forcedToolChoiceUnsupportedModels`
   * too when they apply.
   */
  claudeModels?: ModelCapabilityOverride;
}

export interface ResolvedOptions {
  toolUseSupportedModels: BedrockAdapterOptions['toolUseSupportedModels'];
  nativeStructuredOutputModels: ModelCapabilityOverride | undefined;
  effortTokenTable: EffortTokenTable;
  adaptiveOnlyModels: ModelCapabilityOverride | undefined;
  forcedToolChoiceUnsupportedModels: ModelCapabilityOverride | undefined;
  claudeModels: ModelCapabilityOverride | undefined;
}
