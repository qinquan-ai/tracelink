import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scopeController } from '../../../src/index.js';
import { NodeHttpExporter } from '../../../src/transport/exporters/node-http.js';

describe('NodeHttpExporter', () => {
  beforeEach(() => {
    scopeController.enableAll();
  });

  afterEach(() => {
    scopeController.enableAll();
  });

  it('requires an absolute URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((r) => r(new Response('{}'))) as unknown as ReturnType<typeof globalThis.fetch>,
    );
    const exporter = new NodeHttpExporter({ endpoint: 'http://127.0.0.1:5173/__debug_log' });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'node-trace',
      spanId: 'ns1',
    });
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:5173/__debug_log');
    fetchSpy.mockRestore();
  });

  it('does not call fetch when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const exporter = new NodeHttpExporter({ endpoint: 'http://127.0.0.1:9999/log', disabled: true });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'node-disabled',
      spanId: 'ns2',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('send does not throw even when endpoint is unreachable', async () => {
    const exporter = new NodeHttpExporter({ endpoint: 'http://127.0.0.1:99999/log' });
    expect(() =>
      exporter.send({
        ts: '12:00:00.000',
        layer: 'FE-ACTION',
        fn: 'x:y',
        msg: 'm',
        data: {},
        traceId: 'node-throw-test',
        spanId: 'ns3',
      }),
    ).not.toThrow();
  });

  it('injects x-trace-id and x-debug-scopes headers via callback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((r) => r(new Response('{}'))) as unknown as ReturnType<typeof globalThis.fetch>,
    );
    const exporter = new NodeHttpExporter({
      endpoint: 'http://127.0.0.1:5173/__debug_log',
      getEnabledScopes: () => ['delete-work'],
    });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'node-header-test',
      spanId: 'ns4',
    });
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-trace-id']).toBe('node-header-test');
    expect(headers['x-parent-span-id']).toBe('ns4');
    expect(headers['x-debug-scopes']).toBe('["delete-work"]');
    fetchSpy.mockRestore();
  });

  it('extraHeaders are merged and can override defaults', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((r) => r(new Response('{}'))) as unknown as ReturnType<typeof globalThis.fetch>,
    );
    const exporter = new NodeHttpExporter({
      endpoint: 'http://127.0.0.1:5173/__debug_log',
      getEnabledScopes: () => ['*'],
      extraHeaders: {
        Authorization: 'Bearer token123',
        'x-trace-id': 'override-trace-id',
      },
    });
    exporter.send({
      ts: '12:00:00.000',
      layer: 'FE-ACTION',
      fn: 'x:y',
      msg: 'm',
      data: {},
      traceId: 'original-trace',
      spanId: 'ns5',
    });
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token123');
    expect(headers['x-trace-id']).toBe('override-trace-id');
    fetchSpy.mockRestore();
  });
});
