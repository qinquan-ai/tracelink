import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tracer,
  scopeController,
  setContextProvider,
  StackContextProvider,
} from '../../../src/index.js';
import { installNodeAsyncContext } from '../../../src/runtime/node/index.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('Node async span context (AsyncLocalStorage)', () => {
  beforeEach(() => {
    tracer.enable();
    tracer.clearMemory();
    scopeController.enableAll();
    installNodeAsyncContext();
  });

  afterEach(() => {
    tracer.enable();
    tracer.clearMemory();
    scopeController.enableAll();
    // Restore the default provider so we don't leak the ALS provider.
    setContextProvider(new StackContextProvider());
  });

  it('keeps correct parentSpanId across an await', async () => {
    await tracer.span({ layer: 'BE-ENTRY', fn: 'A.a', msg: 'a' }, async () => {
      await tick();
      tracer.log({ layer: 'BE-INTERNAL', fn: 'B.b', msg: 'b' });
    });

    const [open, child] = tracer.allLogs();
    expect(child!.parentSpanId).toBe(open!.spanId);
    expect(child!.traceId).toBe(open!.traceId);
  });

  it('closes an in-flight async span after its scope is disabled', async () => {
    await tracer.span(
      { layer: 'BE-ENTRY', fn: 'A.a', msg: 'a', scope: 'flow-1' },
      async () => {
        await tick();
        scopeController.disableAll();
      },
    );

    const [open, close] = tracer.allLogs();
    expect(tracer.allLogs()).toHaveLength(2);
    expect(close!.spanId).toBe(open!.spanId);
    expect(close!.async).toBe(true);
  });

  it('keeps parents separate for concurrent async spans', async () => {
    await Promise.all([
      tracer.span({ layer: 'BE-ENTRY', fn: 'A.a', msg: 'a1', scope: 'flow-1' }, async () => {
        await tick();
        tracer.log({ layer: 'BE-INTERNAL', fn: 'child', msg: 'c1', scope: 'flow-1' });
      }),
      tracer.span({ layer: 'BE-ENTRY', fn: 'A.a', msg: 'a2', scope: 'flow-2' }, async () => {
        await tick();
        tracer.log({ layer: 'BE-INTERNAL', fn: 'child', msg: 'c2', scope: 'flow-2' });
      }),
    ]);

    const logs = tracer.allLogs();
    const open1 = logs.find((l) => l.msg === 'a1')!;
    const open2 = logs.find((l) => l.msg === 'a2')!;
    const child1 = logs.find((l) => l.msg === 'c1')!;
    const child2 = logs.find((l) => l.msg === 'c2')!;

    // Each child nests under its OWN span despite interleaved awaits.
    expect(child1.parentSpanId).toBe(open1.spanId);
    expect(child2.parentSpanId).toBe(open2.spanId);
    expect(child1.parentSpanId).not.toBe(open2.spanId);
    expect(child2.parentSpanId).not.toBe(open1.spanId);
  });
});
