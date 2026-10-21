export interface RecordExceptionsOptions {
  /**
   * Default false. Adds the error's stack trace to the exception event. A stack's first line
   * carries the error message, which can echo prompt text, so this is a separate opt in.
   */
  stack?: boolean;
}
