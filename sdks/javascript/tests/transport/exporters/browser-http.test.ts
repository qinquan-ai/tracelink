import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scopeController } from '../../../src/index.js';
import { BrowserHttpExporter } from '../../../src/transport/exporters/browser-http.js';

describe('BrowserHttpExporter auto headers', () => {
  beforeEach(() => {
    scopeController.enableAll();
  });

  afterEach(() => {
    scopeController.enableAll();
  });

  it('injects x-trace-id and x-debug-scopes headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((r) => r(new Response('{}'))) as unknown as ReturnType<typeof globalThis.fetch>,
    );
    const exporter = new BrowserHttpExporter({ endpoint: '/__debug_log' });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'Button:onClick',
      msg: 'clicked',
      data: {},
      traceId: 'my-trace-123',
      spanId: 'abc',
      scope: 'delete-work',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/__debug_log');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-trace-id']).toBe('my-trace-123');
    expect(headers['x-parent-span-id']).toBe('abc');
    expect(headers['x-debug-scopes']).toBe('["*"]');
    fetchSpy.mockRestore();
  });

  it('x-debug-scopes reflects getEnabledScopes callback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((r) => r(new Response('{}'))) as unknown as ReturnType<typeof globalThis.fetch>,
    );
    const exporter = new BrowserHttpExporter({
      endpoint: '/__debug_log',
      getEnabledScopes: () => ['scope-a', 'scope-b'],
    });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'trace-xyz',
      spanId: 'sp1',
    });
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-debug-scopes']).toBe('["scope-a","scope-b"]');
    fetchSpy.mockRestore();
  });

  it('does not call fetch when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const exporter = new BrowserHttpExporter({ endpoint: '/__debug_log', disabled: true });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'no-fetch',
      spanId: 's1',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
