import { parseClaudeVersion, versionAtLeast } from './forcedToolChoice.js';

/**
 * Whether a Claude model rejects `temperature` even on an API version that
 * still accepts it: Claude 4.7 and later, in any family. An id that isn't a
 * recognizable Claude id (a proxy alias, a test name) counts as accepting it.
 */
export function rejectsTemperature(model: string): boolean {
  const version = parseClaudeVersion(model);
  return version !== null && versionAtLeast(version.major, version.minor, 4, 7);
}
