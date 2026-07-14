import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tracer,
  scopeController,
  setContextProvider,
  StackContextProvider,
  currentSpan,
  runInSpan,
} from '../../src/index.js';

describe('auto span context (StackContextProvider)', () => {
  beforeEach(() => {
    tracer.enable();
    tracer.clearMemory();
    scopeController.enableAll();
    // Reset to the default synchronous provider so state doesn't leak.
    setContextProvider(new StackContextProvider());
  });

  afterEach(() => {
    tracer.enable();
    tracer.clearMemory();
    scopeController.enableAll();
    setContextProvider(new StackContextProvider());
  });

  it('sync nesting: child inherits parentSpanId and shares traceId', () => {
    tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a' }, () => {
      tracer.log({ layer: 'FE-ACTION', fn: 'B.b', msg: 'b' });
    });

    // span-open, child, span-close (open + close model — see docs/09 §0.2).
    const logs = tracer.allLogs();
    expect(logs).toHaveLength(3);
    const [open, child, close] = logs as [
      typeof logs[number],
      typeof logs[number],
      typeof logs[number],
    ];

    expect(child.parentSpanId).toBe(open.spanId);
    expect(child.traceId).toBe(open.traceId);
    // The span-open log itself has no enclosing span.
    expect(open.parentSpanId).toBeUndefined();
    // The close event shares the span's id and carries duration + async.
    expect(close.spanId).toBe(open.spanId);
    expect(close.traceId).toBe(open.traceId);
    expect(close.parentSpanId).toBeUndefined();
    expect(typeof close.durationMs).toBe('number');
    expect(close.async).toBe(false);
    // The span-open event carries no duration/async — those mark the close.
    expect(open.durationMs).toBeUndefined();
    expect(open.async).toBeUndefined();
  });

  it('nested spans build a parent chain', () => {
    tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a' }, () => {
      tracer.span({ layer: 'FE-API', fn: 'B.b', msg: 'b' }, () => {
        tracer.log({ layer: 'FE-API', fn: 'C.c', msg: 'c' });
      });
    });

    const [a, b, c] = tracer.allLogs();
    expect(b!.parentSpanId).toBe(a!.spanId);
    expect(c!.parentSpanId).toBe(b!.spanId);
    expect(a!.traceId).toBe(b!.traceId);
    expect(b!.traceId).toBe(c!.traceId);
  });

  it('explicit parentSpanId still wins over context', () => {
    tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a' }, () => {
      tracer.log({
        layer: 'FE-ACTION',
        fn: 'B.b',
        msg: 'b',
        parentSpanId: 'manual-parent',
      });
    });

    const child = tracer.allLogs()[1]!;
    expect(child.parentSpanId).toBe('manual-parent');
  });

  it('no-context behavior is unchanged (parentSpanId undefined)', () => {
    tracer.log({ layer: 'FE-ACTION', fn: 'x', msg: 'no span' });
    const log = tracer.allLogs()[0]!;
    expect(log.parentSpanId).toBeUndefined();
    expect(log.traceId).toBe('no-trace');
  });

  it('span returns the sync result of fn', () => {
    const result = tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a' }, () => 42);
    expect(result).toBe(42);
  });

  it('single async chain keeps context until the promise settles', async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

    const result = await tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a' }, async () => {
      await tick();
      tracer.log({ layer: 'FE-ACTION', fn: 'B.b', msg: 'b' });
      return 'done';
    });
    expect(result).toBe('done');

    // Order: span-open, child, span-close.
    const [open, child, close] = tracer.allLogs();
    expect(child!.parentSpanId).toBe(open!.spanId);
    expect(child!.traceId).toBe(open!.traceId);
    // Close event is emitted after the promise settles and marks async=true.
    expect(close!.spanId).toBe(open!.spanId);
    expect(close!.async).toBe(true);
    expect(typeof close!.durationMs).toBe('number');
    expect(close!.durationMs!).toBeGreaterThanOrEqual(0);

    // Frame popped after settle: subsequent logs have no parent.
    tracer.log({ layer: 'FE-ACTION', fn: 'C.c', msg: 'c' });
    expect(tracer.allLogs()[3]!.parentSpanId).toBeUndefined();
  });

  it('span with explicit scope shares the scope-derived trace with children', () => {
    tracer.span({ layer: 'FE-ACTION', fn: 'A.a', msg: 'a', scope: 'buy-flow' }, () => {
      tracer.log({ layer: 'FE-API', fn: 'B.b', msg: 'b' });
    });

    const [open, child] = tracer.allLogs();
    expect(open!.scope).toBe('buy-flow');
    expect(child!.scope).toBe('buy-flow');
    expect(child!.traceId).toBe(open!.traceId);
    expect(child!.parentSpanId).toBe(open!.spanId);
  });

  it('finishes a recorded span after its scope is disabled', () => {
    tracer.span(
      { layer: 'FE-ACTION', fn: 'A.a', msg: 'a', scope: 'buy-flow' },
      () => scopeController.disableAll(),
    );

    const [open, close] = tracer.allLogs();
    expect(tracer.allLogs()).toHaveLength(2);
    expect(close!.spanId).toBe(open!.spanId);
    expect(close!.durationMs).toBeTypeOf('number');
  });

  it('keeps a suppressed span silent when its scope is enabled mid-flight', () => {
    scopeController.disableAll();

    tracer.span(
      { layer: 'FE-ACTION', fn: 'A.a', msg: 'a', scope: 'buy-flow' },
      () => {
        scopeController.enable('buy-flow');
        tracer.log({ layer: 'FE-API', fn: 'B.b', msg: 'b' });
      },
    );

    expect(tracer.allLogs()).toHaveLength(0);
  });

  it('runInSpan / currentSpan expose the active frame', () => {
    expect(currentSpan()).toBeUndefined();
    runInSpan({ spanId: 's1', traceId: 't1' }, () => {
      expect(currentSpan()?.spanId).toBe('s1');
    });
    expect(currentSpan()).toBeUndefined();
  });
});
