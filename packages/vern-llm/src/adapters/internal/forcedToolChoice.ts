import { LLMError, type WireToolChoice } from '../../types/index.js';

import type { ModelCapabilityOverride } from './nativeStructuredOutput.js';

/**
 * A Claude model id's family and version, e.g. `"claude-opus-5-5"` ->
 * `{ family: 'opus', major: 5, minor: 5 }`. Not anchored, so a Bedrock id
 * (`anthropic.claude-...-v1:0`), a region prefixed inference profile
 * (`us.anthropic.claude-...`), or an ARN containing one all match. The
 * older `claude-3-5-sonnet` order has no family ahead of the version.
 *
 * A second segment of 8 digits or more is a snapshot date
 * (`claude-sonnet-5-20260101`), not a minor version, so it reads as `0`.
 */
function parseClaudeVersion(
  model: string,
): { family?: string; major: number; minor: number } | null {
  const named = /claude-([a-z]+)-(\d+)(?:[-.](\d+))?/i.exec(model);
  const match = named ?? /claude-(\d+)(?:[-.](\d+))?/i.exec(model);
  if (!match) return null;

  const [, first, second, third] = named ? match : [match[0], undefined, match[1], match[2]];
  const minor = third === undefined || third.length >= 8 ? 0 : Number(third);

  return { family: first?.toLowerCase(), major: Number(second), minor };
}

/** Whether `[major, minor]` is at least `[atLeastMajor, atLeastMinor]`. */
function versionAtLeast(major: number, minor: number, atLeastMajor: number, atLeastMinor: number) {
  return major > atLeastMajor || (major === atLeastMajor && minor >= atLeastMinor);
}

/**
 * Built in rule for Claude models that reject a `tool_choice` forcing
 * tool use (`any` or a named `tool`): Claude Fable 5.1 and later, Opus
 * 5.5 and later, and every Claude model of major version 6 or later.
 * Matched as version thresholds so later point releases are covered
 * without a list entry each.
 */
function isDefaultForcedToolChoiceUnsupported(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) return false;

  const { family, major, minor } = version;

  if (major >= 6) return true;
  if (family === 'fable') return versionAtLeast(major, minor, 5, 1);
  if (family === 'opus') return versionAtLeast(major, minor, 5, 5);
  return false;
}

/**
 * Whether `model` rejects a forced `tool_choice`. `override`, when given,
 * replaces the built in rule entirely, so a caller can both add a model
 * and take one back out, for a model the rule gets wrong either way.
 */
export function rejectsForcedToolChoice(
  model: string,
  override?: ModelCapabilityOverride,
): boolean {
  if (!override) return isDefaultForcedToolChoiceUnsupported(model);

  return Array.isArray(override) ? override.includes(model) : override(model);
}

/**
 * Throws `LLMError('invalid_params')`, code `unsupported_capability`,
 * when `toolChoice` forces tool use on a model that rejects it. Thrown
 * before dispatch, so it is never retried and never counts toward the
 * circuit breaker, and fallback may still try a target that accepts it.
 * `'auto'`, `'none'`, and an unset choice pass.
 */
export function assertForcedToolChoiceSupported(
  provider: string,
  model: string,
  toolChoice: WireToolChoice | undefined,
  override?: ModelCapabilityOverride,
): void {
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') return;
  if (!rejectsForcedToolChoice(model, override)) return;

  const described =
    toolChoice === 'required'
      ? "toolChoice: 'required'"
      : `toolChoice: { name: '${toolChoice.function.name}' }`;

  throw new LLMError(
    `${provider} model "${model}" rejects a tool_choice that forces tool use, so ${described} ` +
      "can't be sent. Use toolChoice: 'auto' and ask for the tool in the prompt instead. If " +
      'this model does accept it, list the models that reject it in forcedToolChoiceUnsupportedModels.',
    'invalid_params',
    { code: 'unsupported_capability', issues: { capability: 'forced_tool_choice' } },
  );
}
