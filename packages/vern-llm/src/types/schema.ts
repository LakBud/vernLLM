/**
 * Minimal structural type for a Zod-like schema, so this package doesnt need
 * a hard dependency on a specific Zod major version. Any object exposing
 * `safeParse` (Zod v3/v4, and most Zod-compatible validators) should satisfy this
 */
export interface SchemaLike<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * A provider-native JSON Schema for structured outputs (OpenAI/Groq
 * `response_format: { type: 'json_schema' }`) This is the wire-format
 * schema the model is constrained to generate against, distinct from
 * `schema`, which is a client-side Zod validator run on the parsed result
 * You can use one, both, or neither; using both gets you provider-level
 * constraint plus client-side type inference/validation as a safety net
 */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
  /** Enforces the schema strictly (OpenAI-specific), default true when supported */
  strict?: boolean;
  description?: string;
}
