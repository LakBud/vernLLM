import type {
  Exception,
  Link,
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanContext,
  SpanStatus,
  TimeInput,
} from '@opentelemetry/api';

/**
 * A span that only starts the first time anything touches it. An attempt the adapter rejects
 * before sending anything then leaves no CLIENT span behind, while a span started under it, such
 * as an HTTP client span, still finds it as its parent. `start` must never throw.
 */
export class DeferredSpan implements Span {
  private span: Span | undefined;

  constructor(private readonly start: () => Span) {}

  get started(): boolean {
    return this.span !== undefined;
  }

  private real(): Span {
    return (this.span ??= this.start());
  }

  spanContext(): SpanContext {
    return this.real().spanContext();
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.real().setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: SpanAttributes): this {
    this.real().setAttributes(attributes);
    return this;
  }

  addEvent(
    name: string,
    attributesOrStartTime?: SpanAttributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    this.real().addEvent(name, attributesOrStartTime, startTime);
    return this;
  }

  addLink(link: Link): this {
    this.real().addLink(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.real().addLinks(links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.real().setStatus(status);
    return this;
  }

  updateName(name: string): this {
    this.real().updateName(name);
    return this;
  }

  end(endTime?: TimeInput): void {
    this.real().end(endTime);
  }

  isRecording(): boolean {
    return this.real().isRecording();
  }

  recordException(exception: Exception, time?: TimeInput): void {
    this.real().recordException(exception, time);
  }
}
