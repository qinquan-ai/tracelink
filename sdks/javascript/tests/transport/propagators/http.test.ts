import { describe, expect, it } from 'vitest';
import {
  createTraceHeaders,
  extractTraceContext,
  injectTraceHeaders,
  runInSpan,
  scopeController,
} from '../../../src/index.js';

describe('HTTP context propagator', () => {
  it('round-trips trace, parent span, and scopes', () => {
    const headers = injectTraceHeaders(
      { Authorization: 'Bearer test' },
      { traceId: 'trace-1', spanId: 'span-7', scopes: ['checkout'] },
    );

    expect(headers.Authorization).toBe('Bearer test');
    expect(extractTraceContext(headers)).toEqual({
      traceId: 'trace-1',
      parentSpanId: 'span-7',
      scopes: ['checkout'],
    });
  });

  it('preserves caller headers using case-insensitive names', () => {
    const headers = injectTraceHeaders(
      { 'X-Trace-Id': 'caller-trace' },
      { traceId: 'engine-trace', spanId: 'span-1' },
    );

    expect(headers['X-Trace-Id']).toBe('caller-trace');
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'x-trace-id')).toHaveLength(1);
  });

  it('creates business-request headers from the active span', () => {
    scopeController.setEnabled(['checkout']);
    runInSpan(
      { spanId: 'active-span', traceId: 'active-trace', scope: 'checkout' },
      () => {
        expect(extractTraceContext(createTraceHeaders())).toEqual({
          traceId: 'active-trace',
          parentSpanId: 'active-span',
          scopes: ['checkout'],
        });
      },
    );
    scopeController.enableAll();
  });

  it('does not combine an overridden trace with the active span', () => {
    runInSpan({ spanId: 'span-a', traceId: 'trace-a' }, () => {
      expect(extractTraceContext(createTraceHeaders({ traceId: 'trace-b' }))).toEqual({
        traceId: 'trace-b',
        parentSpanId: undefined,
        scopes: ['*'],
      });
    });
  });

  it('distinguishes an explicit empty Scope policy from a missing header', () => {
    expect(extractTraceContext({ 'x-debug-scopes': '[]' }).scopes).toEqual([]);
    expect(extractTraceContext({}).scopes).toBeUndefined();
  });
});
