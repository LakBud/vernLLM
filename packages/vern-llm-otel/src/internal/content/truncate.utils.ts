export const TRUNCATION_MARKER = '…[truncated]';

/**
 * Cuts `text` to `maxLength` UTF-16 units without splitting a surrogate pair, and appends a
 * marker only when something was cut.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let end = Math.max(0, maxLength);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;

  return text.slice(0, end) + TRUNCATION_MARKER;
}
