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

  error.message = `${pending.prefix}: ${redacted}`;

  // The stack's first line copies the message as it was when the error
  // was built, so it would still carry the raw body.
  if (typeof error.stack === 'string') {
    const firstLineEnd = error.stack.indexOf('\n');
    error.stack =
      `${error.name}: ${error.message}` +
      (firstLineEnd === -1 ? '' : error.stack.slice(firstLineEnd));
  }
}
