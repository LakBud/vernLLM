import type { ResolvedCacheAware } from '../types/index.js';
import type { WireCallRequest } from 'vern-llm';

/** Most remembered prefixes. The oldest are dropped first. */
const MAX_ENTRIES = 10_000;

/** A fast, non cryptographic 53 bit hash. A collision only changes a heuristic. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The text of one message, whatever its content shape. Anything that is not text is skipped. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      const text = (block as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * Remembers which targets recently served which prompt prefix from their cache. A provider's
 * prompt cache only helps a request that starts the same way, so the prefix is what is keyed.
 */
export class CacheAware {
  /** `target|prefix` to when the target last served that prefix from its cache. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly config: ResolvedCacheAware) {}

  /** A key for how the request starts: the same for requests sharing their first characters. */
  keyOf(request: Readonly<WireCallRequest>): string {
    let text = '';
    for (const message of request.messages) {
      text += `${message.role}:${textOf(message.content)}\n`;
      if (text.length >= this.config.prefixChars) break;
    }
    return hash(text.slice(0, this.config.prefixChars));
  }

  /** The target served this prefix from its cache just now. */
  remember(target: string, key: string, now: number): void {
    const id = `${target}|${key}`;
    // Deleted first, so a refreshed entry moves to the end and the oldest is dropped first.
    this.seen.delete(id);
    this.seen.set(id, now);
    if (this.seen.size > MAX_ENTRIES) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Whether the target served this prefix from its cache within `ttlMs`. */
  warm(target: string, key: string, now: number): boolean {
    const at = this.seen.get(`${target}|${key}`);
    return at !== undefined && now - at >= 0 && now - at < this.config.ttlMs;
  }

  get size(): number {
    return this.seen.size;
  }
}
