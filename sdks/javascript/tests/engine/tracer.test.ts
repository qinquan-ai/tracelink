import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tracer, scopeController } from '../../src/index.js';
import type { TraceLog } from '../../src/index.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(10);
  }
}

describe('scopeController', () => {
  beforeEach(() => {
    scopeController.enableAll();
  });

  afterEach(() => {
    scopeController.enableAll();
  });

  it('starts with all enabled', () => {
    expect(scopeController.isEnabled('anything')).toBe(true);
    expect(scopeController.getConfig().enabledScopes).toEqual(['*']);
  });

  it('enables a single scope and disables the wildcard', () => {
    scopeController.enable('delete-work');
    expect(scopeController.isEnabled('delete-work')).toBe(true);
    expect(scopeController.isEnabled('other-scope')).toBe(false);
  });

  it('disables a single scope', () => {
    scopeController.enable('delete-work'); // must be enabled before disabling
    scopeController.disable('delete-work');
    expect(scopeController.isEnabled('delete-work')).toBe(false);
  });

  it('enableAll restores wildcard', () => {
    scopeController.disableAll();
    expect(scopeController.isEnabled('foo')).toBe(false);
    scopeController.enableAll();
    expect(scopeController.isEnabled('foo')).toBe(true);
  });

  it('notify fires on changes', () => {
    const events: string[] = [];
    scopeController.subscribe((cfg) => events.push(cfg.enabledScopes.join(',')));
    scopeController.disableAll();
    scopeController.enable('foo');
    expect(events).toEqual(['', 'foo']);
  });
});

describe('tracer (in-memory)', () => {
  beforeEach(() => {
    tracer.enable();
    tracer.configure({ memory: true });
    tracer.clearMemory();
    scopeController.enableAll();
  });

  afterEach(() => {
    tracer.enable();
    tracer.configure({ memory: true });
    tracer.clearMemory();
    scopeController.enableAll();
  });

  it('emits events to the memory exporter', () => {
    tracer.action('Button:onClick', 'clicked', { id: 1 });
    const all = tracer.allLogs();
    expect(all).toHaveLength(1);
    expect(all[0]!.layer).toBe('FE-ACTION');
    expect(all[0]!.msg).toBe('clicked');
    expect(all[0]!.data).toEqual({ id: 1 });
  });

  it('startScope / endScope create correlated events', () => {
    scopeController.enableAll(); // ensure clean state
    const id = tracer.startScope('delete-work');
    tracer.log({ layer: 'FE-ACTION', fn: 'x', msg: 'a', scope: 'delete-work' });
    tracer.log({ layer: 'FE-API', fn: 'y', msg: 'b', scope: 'delete-work' });
    const duration = tracer.endScope('delete-work');
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThanOrEqual(0);

    const logs = tracer.allLogs();
    // 2 user events + 2 synthetic (start, end) = 4
    expect(logs).toHaveLength(4);
    expect(logs.every((l) => l.traceId === id)).toBe(true);
    expect(logs.every((l) => l.scope === 'delete-work')).toBe(true);
  });

  it('can disable the memory exporter', () => {
    tracer.configure({ memory: false });
    tracer.action('Button:onClick', 'not buffered');
    expect(tracer.allLogs()).toHaveLength(0);
  });

  it('finishes a recorded scope session after its scope is disabled', () => {
    tracer.startScope('delete-work');
    scopeController.disableAll();
    tracer.endScope('delete-work');

    const logs = tracer.allLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]!.fn).toBe('Tracer:startScope');
    expect(logs[1]!.fn).toBe('Tracer:endScope');
    expect(logs[1]!.traceId).toBe(logs[0]!.traceId);
  });

  it('filters out events for disabled scopes', () => {
    scopeController.disableAll();
    scopeController.enable('cancel-task');
    tracer.log({ layer: 'FE-ACTION', fn: 'x', msg: 'a', scope: 'delete-work' });
    tracer.log({ layer: 'FE-ACTION', fn: 'y', msg: 'b', scope: 'cancel-task' });
    const logs = tracer.allLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.scope).toBe('cancel-task');
  });

  it('summary() counts by layer and scope', () => {
    tracer.log({ layer: 'FE-ACTION', fn: 'x', msg: 'a', scope: 'delete-work' });
    tracer.log({ layer: 'FE-ACTION', fn: 'x', msg: 'a', scope: 'delete-work' });
    tracer.log({ layer: 'FE-API', fn: 'y', msg: 'b', scope: 'card-create' });
    const s = tracer.summary();
    expect(s.total).toBe(3);
    expect(s.byLayer['FE-ACTION']).toBe(2);
    expect(s.byLayer['FE-API']).toBe(1);
    expect(s.byScope['delete-work']).toBe(2);
    expect(s.byScope['card-create']).toBe(1);
  });

  it('sanitizes long strings and base64 data URLs', () => {
    const longStr = 'x'.repeat(500);
    tracer.action('fn', 'msg', { long: longStr, img: 'data:image/png;base64,' + 'A'.repeat(200) });
    const log = tracer.allLogs()[0]!;
    const data = log.data as Record<string, unknown>;
    expect((data['long'] as string).length).toBeLessThan(500);
    expect((data['long'] as string)).toMatch(/\[500 chars\]/);
    expect((data['img'] as string)).toContain('[truncated]');
  });

  it('custom exporters receive all events', () => {
    const received: TraceLog[] = [];
    tracer.addExporter((log) => received.push(log));
    tracer.action('fn', 'msg1');
    tracer.action('fn', 'msg2');
    expect(received).toHaveLength(2);
  });

  it('master switch disable silences everything', () => {
    tracer.disable();
    tracer.action('fn', 'msg');
    expect(tracer.allLogs()).toHaveLength(0);
  });

  it('normal logs carry no outcome (absent = call)', () => {
    tracer.action('fn', 'msg');
    expect(tracer.allLogs()[0]!.outcome).toBeUndefined();
  });

  it('blocked() sets outcome=blocked, level=warn, data.reason', () => {
    tracer.blocked('routes/work:delete', 'DELETE rejected', {
      reason: 'insufficient permission',
      data: { workId: 'w_1' },
    });
    const log = tracer.allLogs()[0]!;
    expect(log.outcome).toBe('blocked');
    expect(log.level).toBe('warn');
    expect(log.layer).toBe('FE-ACTION');
    expect((log.data as Record<string, unknown>).reason).toBe('insufficient permission');
    expect((log.data as Record<string, unknown>).workId).toBe('w_1');
  });

  it('intent() sets outcome=intent, level=info, and honors layer/scope override', () => {
    scopeController.enableAll();
    tracer.intent('cart:checkout', 'would checkout', {
      reason: 'feature flag off',
      layer: 'BE-ENTRY',
      scope: 'buy-flow',
    });
    const log = tracer.allLogs()[0]!;
    expect(log.outcome).toBe('intent');
    expect(log.level).toBe('info');
    expect(log.layer).toBe('BE-ENTRY');
    expect(log.scope).toBe('buy-flow');
    expect((log.data as Record<string, unknown>).reason).toBe('feature flag off');
  });
});

describe('tracer.configure({ scopeSync })', () => {
  const realFetch = globalThis.fetch;

  function scopeStreamResponse(enabled: string[]): Response {
    const encoder = new TextEncoder();
    const frame = `event: scopes\ndata: ${JSON.stringify({ enabled })}\n\n`;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const split = Math.floor(frame.length / 2);
          controller.enqueue(encoder.encode(frame.slice(0, split)));
          controller.enqueue(encoder.encode(frame.slice(split)));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  afterEach(() => {
    tracer.configure({ scopeSync: false });
    globalThis.fetch = realFetch;
    scopeController.enableAll();
  });

  it('streams and applies the returned enabled scopes', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return scopeStreamResponse(['delete-work']);
    }) as typeof fetch;

    scopeController.enableAll();
    tracer.configure({ scopeSync: { endpoint: 'http://127.0.0.1:5174/__debug_log/scopes' } });

    await waitFor(() => scopeController.getConfig().enabledScopes.join(',') === 'delete-work');
    expect(scopeController.getConfig().enabledScopes).toEqual(['delete-work']);
    expect(scopeController.isEnabled('other')).toBe(false);
    expect(requestedUrl).toBe('http://127.0.0.1:5174/__debug_log/scopes/stream');
  });

  it('treats ["*"] as enable-all', async () => {
    globalThis.fetch = (async () => scopeStreamResponse(['*'])) as typeof fetch;

    scopeController.disableAll();
    tracer.configure({ scopeSync: { endpoint: 'http://x' } });

    await waitFor(() => scopeController.isEnabled('anything') === true);
    expect(scopeController.getConfig().enabledScopes).toEqual(['*']);
  });

  it('reconnects after the control stream is unavailable', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 503 })
        : scopeStreamResponse(['recovered']);
    }) as typeof fetch;

    scopeController.enableAll();
    tracer.configure({
      scopeSync: { endpoint: 'http://x', reconnectDelayMs: 10 },
    });

    await waitFor(() => scopeController.getConfig().enabledScopes.join(',') === 'recovered');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('scopeSync: false stops stream reconnects', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return scopeStreamResponse(['a']);
    }) as typeof fetch;

    tracer.configure({ scopeSync: { endpoint: 'http://x', reconnectDelayMs: 20 } });
    await waitFor(() => calls >= 1);
    tracer.configure({ scopeSync: false });
    const snapshot = calls;
    await delay(120);
    expect(calls).toBe(snapshot);
  });
});
