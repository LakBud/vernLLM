/** Builds the Redis key one circuit bucket lives under, either one shared key or one per model. */
export function bucketKey(
  prefix: string,
  isolateByModel: boolean,
  model: string | undefined,
): string {
  return isolateByModel ? `${prefix}:${model ?? 'default'}` : prefix;
}

/** Reverses bucketKey: strips the prefix back off to recover the model this key belongs to, or undefined when isolateByModel is off. */
export function modelFromKey(
  key: string,
  prefix: string,
  isolateByModel: boolean,
): string | undefined {
  if (!isolateByModel) return undefined;
  const suffix = key.slice(prefix.length + 1);
  return suffix === 'default' ? undefined : suffix;
}
