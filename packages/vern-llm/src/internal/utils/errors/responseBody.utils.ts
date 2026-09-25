/**
 * Lets an adapter build an error whose message embeds a raw provider
 * response body, while keeping that body redactable. The adapter has no
 * access to `VernLLMOptions.redact`, so it records where the body sits
 * and `redactResponseBody` rewrites the message once core has caught it,
 * before it becomes `LLMError.message` or reaches any log.
 */

/** How much of a response body an error message keeps. */
const MAX_BODY_CHARS = 500;

const pendingBodies = new WeakMap<Error, { prefix: string; body: string }>();

/** An `Error` reading `${prefix}: ${body}`, with the body registered for redaction. */
export function errorWithResponseBody(prefix: string, body: string): Error {
  const truncated = body.slice(0, MAX_BODY_CHARS);
  const error = new Error(`${prefix}: ${truncated}`);
  pendingBodies.set(error, { prefix, body: truncated });
  return error;
}

/**
 * Passes the body of an error built by `errorWithResponseBody` through
 * `redact`, rewriting its message in place. Runs at most once per error.
 * A throwing `redact` drops the body instead of leaking it unredacted.
 */
export function redactResponseBody(error: unknown, redact: (text: string) => string): void {
  if (!(error instanceof Error)) return;

  const pending = pendingBodies.get(error);
  if (!pending) return;

  pendingBodies.delete(error);

  let redacted: string;

  try {
    redacted = redact(pending.body);
  } catch {
    redacted = '[response body withheld: redact threw]';
  }

  // Read before the message changes: V8 formats `stack` lazily on first
  // access, from whatever the message is at that moment.
  const rawStack = error.stack;
  const rawHeader = `${error.name}: ${error.message}`;

  error.message = `${pending.prefix}: ${redacted}`;

  // The stack starts with the message as it was when the error was built,
  // and a body with newlines spans several lines of it. Replace exactly
  // that header so no part of the raw body survives, keeping the frames.
  // A stack that doesn't start with it (rewritten elsewhere) is dropped to
  // its header rather than risk keeping body text.
  if (typeof rawStack === 'string') {
    const frames = rawStack.startsWith(rawHeader) ? rawStack.slice(rawHeader.length) : '';
    error.stack = `${error.name}: ${error.message}${frames}`;
  }
}
