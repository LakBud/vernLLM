export interface CustomEventsOptions {
  /**
   * Default false. Adds each event's `data` as JSON. It is whatever a middleware passes to
   * `ctx.emit`, so it can hold identity or content, which makes it a separate opt in.
   */
  data?: boolean;
  /** Max characters of the serialized `data`. Positive integer or Infinity. Default 8192. */
  maxLength?: number;
}
