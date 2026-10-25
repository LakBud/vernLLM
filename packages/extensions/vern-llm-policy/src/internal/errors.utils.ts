/** Long enough to say what broke, short enough for a log line. */
const MAX_ERROR_MESSAGE = 200;
const MAX_ERROR_NAME = 60;

/** The kind of error, which holds no `context` value. */
export function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return name.length > MAX_ERROR_NAME ? name.slice(0, MAX_ERROR_NAME) : name;
}

export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}...` : message;
}
