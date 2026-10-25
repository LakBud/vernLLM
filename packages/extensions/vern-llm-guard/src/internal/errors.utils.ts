const MAX_ERROR_NAME = 60;

/** The kind of error, never its message: a detector's message may quote the input. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return name.length > MAX_ERROR_NAME ? name.slice(0, MAX_ERROR_NAME) : name;
}
