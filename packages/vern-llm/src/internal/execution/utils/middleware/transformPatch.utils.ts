import {
  LLMError,
  type WireCallRequest,
  type WireCallRequestPatch,
} from '../../../../types/index.js';

const PATCH_FIELDS: (keyof WireCallRequestPatch)[] = [
  'temperature',
  'max_tokens',
  'reasoning_effort',
  'budget_tokens',
  'tool_choice',
  'messages',
  'addMessages',
  'tools',
  'addTools',
];

/**
 * Merges one `transform` patch onto the request. `addMessages` and `addTools` append; everything
 * else overwrites. Returns the request and which fields changed, for the `'middleware'` event.
 */
export function mergePatch(
  request: WireCallRequest,
  patch: WireCallRequestPatch,
): { request: WireCallRequest; patchedFields: string[] } {
  // `model` and `response_format` aren't on the patch type, but untyped code can still set them.
  // Copied through so the unchanged check can catch them.
  const rawPatch = patch as WireCallRequestPatch & {
    model?: unknown;
    response_format?: unknown;
  };

  const patchedFields: string[] = PATCH_FIELDS.filter((field) => patch[field] !== undefined);
  if (rawPatch.model !== undefined) patchedFields.push('model');
  if (rawPatch.response_format !== undefined) patchedFields.push('response_format');

  if (patchedFields.length === 0) {
    return { request, patchedFields: [] };
  }

  const next: WireCallRequest = { ...request };

  if (rawPatch.model !== undefined) next.model = rawPatch.model as string;
  if (rawPatch.response_format !== undefined) {
    next.response_format = rawPatch.response_format as WireCallRequest['response_format'];
  }

  if (patch.temperature !== undefined) next.temperature = patch.temperature;
  if (patch.max_tokens !== undefined) next.max_tokens = patch.max_tokens;
  if (patch.reasoning_effort !== undefined) next.reasoning_effort = patch.reasoning_effort;
  if (patch.budget_tokens !== undefined) next.budget_tokens = patch.budget_tokens;
  if (patch.tool_choice !== undefined) next.tool_choice = patch.tool_choice;

  if (patch.messages !== undefined) {
    next.messages = patch.messages;
  }
  if (patch.addMessages !== undefined && patch.addMessages.length > 0) {
    next.messages = [...next.messages, ...patch.addMessages];
  }

  if (patch.tools !== undefined) {
    next.tools = patch.tools;
  }
  if (patch.addTools !== undefined && patch.addTools.length > 0) {
    next.tools = [...(next.tools ?? []), ...patch.addTools];
  }

  return { request: next, patchedFields };
}

/** Throws `LLMError('invalid_params')` naming `label` if `merged.tools` has a duplicate name, run right after the addTools merge that could have introduced one. */
export function assertNoDuplicateTools(request: WireCallRequest, label: string): void {
  if (!request.tools) return;

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const tool of request.tools) {
    if (seen.has(tool.function.name)) duplicates.add(tool.function.name);
    seen.add(tool.function.name);
  }

  if (duplicates.size > 0) {
    throw new LLMError(
      `middleware "${label}" added tool(s) with duplicate name(s): [${[...duplicates].join(', ')}]. Tool names must be unique.`,
      'invalid_params',
      { code: 'duplicate_tool_names', issues: { names: [...duplicates] } },
    );
  }
}

/** Backstop for callers who bypass the type system: `transform` can't express a change to `model`/`response_format` in TypeScript, this catches it at runtime for `any`/plain-JS callers. */
export function assertModelAndResponseFormatUnchanged(
  before: WireCallRequest,
  after: WireCallRequest,
  label: string,
): void {
  if (after.model !== before.model) {
    throw new LLMError(
      `middleware "${label}" changed \`model\` via transform, which isn't supported. Configure the target's model instead.`,
      'invalid_params',
    );
  }

  if (JSON.stringify(after.response_format) !== JSON.stringify(before.response_format)) {
    throw new LLMError(
      `middleware "${label}" changed \`response_format\` via transform, which isn't supported.`,
      'invalid_params',
    );
  }
}
