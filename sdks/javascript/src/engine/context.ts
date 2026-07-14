/**
 * Span context — the pluggable abstraction that lets nested tracer calls
 * discover their enclosing span without the user threading `parentSpanId`
 * by hand.
 *
 * This module is PURE JS and MUST stay browser-safe: it must never import
 * `node:async_hooks` (that would poison the browser bundle). The default
 * provider is a synchronous array stack. The Node entry
 * (`tracelink/node`) swaps in an `AsyncLocalStorage`-backed
 * provider that is correct across `await` and concurrent async.
 *
 * Correctness of the default `StackContextProvider`:
 *   - Synchronous nesting: always correct.
 *   - A single async chain: correct — the frame is held until the returned
 *     thenable settles.
 *   - Concurrent async on the same tick: NOT correct (frames interleave).
 *     Import the Node entry to get the ALS provider for that case.
 */

export interface SpanContext {
  spanId: string;
  traceId: string;
  scope?: string;
  /** Capture decision fixed when this span starts. */
  recording?: boolean;
}

export interface ContextProvider {
  run<T>(ctx: SpanContext, fn: () => T): T;
  current(): SpanContext | undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Default provider — a synchronous stack. `run` pushes the context, invokes
 * `fn`, and pops in a try/finally for the synchronous case. If `fn()` returns
 * a thenable, the frame is kept until it settles (popped in `.then`) so a
 * single async chain still observes the correct context.
 */
export class StackContextProvider implements ContextProvider {
  private stack: SpanContext[] = [];

  run<T>(ctx: SpanContext, fn: () => T): T {
    this.stack.push(ctx);
    let popped = false;
    const pop = (): void => {
      if (popped) return;
      // Defensive: remove this exact frame even if something nested above it
      // failed to unwind cleanly.
      const i = this.stack.lastIndexOf(ctx);
      if (i >= 0) this.stack.splice(i, 1);
      popped = true;
    };

    try {
      const result = fn();
      if (isThenable(result)) {
        return (result as unknown as Promise<unknown>).then(
          (value) => {
            pop();
            return value;
          },
          (err) => {
            pop();
            throw err;
          },
        ) as unknown as T;
      }
      pop();
      return result;
    } catch (err) {
      pop();
      throw err;
    }
  }

  current(): SpanContext | undefined {
    return this.stack[this.stack.length - 1];
  }
}

let provider: ContextProvider = new StackContextProvider();

/** Swap the active context provider (e.g. the Node ALS provider). */
export function setContextProvider(p: ContextProvider): void {
  provider = p;
}

/** The context of the enclosing span, if any. */
export function currentSpan(): SpanContext | undefined {
  return provider.current();
}

/** Run `fn` with `ctx` as the active span context. */
export function runInSpan<T>(ctx: SpanContext, fn: () => T): T {
  return provider.run(ctx, fn);
}
