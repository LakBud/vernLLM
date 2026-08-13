/** Default `parseJson`: `JSON.parse` wrapped in try/catch, returning `undefined` on failure. */
export function defaultParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
