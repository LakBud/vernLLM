import type { FallbackTarget } from '../../types/fallback.js';

/**
 * One name per target, primary first. Throws when two targets share a name, since usage and events
 * identify a target by it.
 */
export function resolveTargetNames(
  targets: readonly FallbackTarget[],
  providerName: string,
): string[] {
  const names = targets.map(
    // Defaults are 0-indexed among fallbacks, so `i - 1`, matching `FallbackAttempt.index`.
    (target, i) => target.name ?? (i > 0 ? `fallback[${i - 1}]` : providerName),
  );

  // A config mistake caught once at construction, so a plain Error rather than an LLMError.
  // Only hand set names can collide, including one that matches another target's default.
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    throw new Error(
      `[VernLLM] target name "${duplicate}" is used by more than one target. Names identify targets in usage, events and \`targets\`.`,
    );
  }

  return names;
}
