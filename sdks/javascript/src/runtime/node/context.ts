/**
 * Node async-correct span context.
 *
 * This file lives ONLY in the Node build, so importing `node:async_hooks`
 * here is safe — it never reaches the browser bundle. It provides an
 * `AsyncLocalStorage`-backed ContextProvider that keeps the enclosing span
 * correct across `await` and concurrent async chains, unlike the default
 * synchronous stack in `../context.ts`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextProvider, SpanContext } from '../../engine/context.js';
import { setContextProvider } from '../../engine/context.js';

export class AlsContextProvider implements ContextProvider {
  private als = new AsyncLocalStorage<SpanContext>();

  run<T>(ctx: SpanContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  current(): SpanContext | undefined {
    return this.als.getStore();
  }
}

/**
 * Install the async-correct provider as the process-wide context provider.
 * Called automatically when `tracelink/node` is imported; also
 * exported for explicit use (e.g. after resetting the provider in tests).
 */
export function installNodeAsyncContext(): void {
  setContextProvider(new AlsContextProvider());
}
