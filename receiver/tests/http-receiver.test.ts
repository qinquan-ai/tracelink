import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  createReceiverHandler,
  RECEIVER_VERSION,
  TRACE_PROTOCOL_VERSION,
} from '../service/handler.js';
import { startReceiverServer } from '../hosts/http/index.js';
import type { TraceLog } from '../../protocol/types.js';

function makeLog(overrides: Partial<TraceLog> = {}): TraceLog {
  return {
    ts: '12:00:00.000',
    layer: 'FE-ACTION',
    fn: 'Button:onClick',
    msg: 'clicked',
    data: {},
    traceId: 'trace-1',
    spanId: 's1',
    ...overrides,
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(20);
  }
}

function waitListening(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

function listeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no TCP listening port');
  return address.port;
}

/** Minimal in-process request helper that drives the handler directly. */
function callHandler(
  handler: ReturnType<typeof createReceiverHandler>,
  opts: { method: string; url?: string; body?: string },
): Promise<{ statusCode: number; body: string; headers: Record<string, string | number | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = new http.IncomingMessage(null as never);
    req.method = opts.method;
    req.url = opts.url ?? '/__debug_log';

    const res = new http.ServerResponse(req);
    const headers: Record<string, string | number | string[] | undefined> = {};
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: never) => {
      headers[name.toLowerCase()] = value;
      return originalSetHeader(name, value);
    }) as typeof res.setHeader;

    const originalEnd = res.end.bind(res);
    res.end = ((data?: unknown) => {
      if (typeof data === 'string') chunks.push(data);
      resolve({ statusCode: res.statusCode, body: chunks.join(''), headers });
      return res;
    }) as typeof res.end;

    Promise.resolve(handler(req, res)).catch(reject);

    // Feed the request body then signal end, mimicking node's stream events.
    if (opts.body !== undefined) req.push(opts.body);
    req.push(null);
  });
}

describe('createReceiverHandler', () => {
  let dir: string;
  let ndjsonPath: string;
  let readablePath: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `tracelink-receiver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ndjsonPath = path.join(dir, '.tracelink', 'trace.ndjson');
    readablePath = path.join(dir, '.tracelink', 'trace.log');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('POST valid JSON returns 204 and writes NDJSON + readable files', async () => {
    const handler = createReceiverHandler({ dir });
    const log = makeLog({ msg: 'first', data: { workId: 42 } });
    const res = await callHandler(handler, { method: 'POST', body: JSON.stringify(log) });

    expect(res.statusCode).toBe(204);
    expect(existsSync(ndjsonPath)).toBe(true);

    const ndjson = await fs.readFile(ndjsonPath, 'utf-8');
    const parsed = JSON.parse(ndjson.trim());
    expect(parsed.msg).toBe('first');
    expect(parsed.data.workId).toBe(42);

    const readable = await fs.readFile(readablePath, 'utf-8');
    expect(readable).toContain('[FE-ACTION]');
    expect(readable).toContain('first');
  });

  it('POST invalid JSON returns 400', async () => {
    const handler = createReceiverHandler({ dir });
    const res = await callHandler(handler, { method: 'POST', body: '{not valid json' });
    expect(res.statusCode).toBe(400);
  });

  it('GET without params returns NDJSON content', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ msg: 'a' })) });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ msg: 'b' })) });

    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log' });
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).msg).toBe('a');
    expect(JSON.parse(lines[1]!).msg).toBe('b');
  });

  it('GET ?report returns head/tail text', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ msg: 'reportable' })) });

    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log?report' });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('=== HEAD (first 20) ===');
    expect(res.body).toContain('=== TAIL (last 50) ===');
    expect(res.body).toContain('reportable');
  });

  it('DELETE returns 204 and removes both files', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog()) });
    expect(existsSync(ndjsonPath)).toBe(true);
    expect(existsSync(readablePath)).toBe(true);

    const res = await callHandler(handler, { method: 'DELETE' });
    expect(res.statusCode).toBe(204);
    expect(existsSync(ndjsonPath)).toBe(false);
    expect(existsSync(readablePath)).toBe(false);
  });

  it('every response carries CORS + identity headers', async () => {
    const handler = createReceiverHandler({ dir });
    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(res.headers['access-control-allow-headers']).toContain('x-debug-scopes');
    expect(res.headers['access-control-allow-headers']).toContain('x-parent-span-id');
    expect(res.headers['x-tracelink-receiver']).toBe(TRACE_PROTOCOL_VERSION);
    expect(RECEIVER_VERSION).toBe(TRACE_PROTOCOL_VERSION);
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const handler = createReceiverHandler({ dir });
    const res = await callHandler(handler, { method: 'OPTIONS', url: '/__debug_log' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET, POST, DELETE, OPTIONS');
  });

  it('honors a custom cors origin', async () => {
    const handler = createReceiverHandler({ dir, cors: 'http://localhost:3000' });
    const res = await callHandler(handler, { method: 'OPTIONS', url: '/__debug_log' });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('GET /scopes returns enabled + known, defaulting to ["*"]', async () => {
    const handler = createReceiverHandler({ dir, persistScopes: false });
    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log/scopes' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.enabled).toEqual(['*']);
    expect(body.known).toEqual([]);
  });

  it('POST /scopes stores authoritative scopes and GET reflects them', async () => {
    const handler = createReceiverHandler({ dir, persistScopes: false });
    const post = await callHandler(handler, {
      method: 'POST',
      url: '/__debug_log/scopes',
      body: JSON.stringify({ enabled: ['delete-work', 'card-create'] }),
    });
    expect(post.statusCode).toBe(204);

    const get = await callHandler(handler, { method: 'GET', url: '/__debug_log/scopes' });
    expect(JSON.parse(get.body).enabled).toEqual(['delete-work', 'card-create']);
  });

  it('POST /scopes persists to .tracelink/scopes.json when enabled', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, {
      method: 'POST',
      url: '/__debug_log/scopes',
      body: JSON.stringify({ enabled: ['upi-billing'] }),
    });
    await waitFor(() => existsSync(path.join(dir, '.tracelink', 'scopes.json')));
    const persisted = JSON.parse(await fs.readFile(path.join(dir, '.tracelink', 'scopes.json'), 'utf-8'));
    expect(persisted).toEqual({ enabled: ['upi-billing'], known: [] });
  });

  it('persists newly discovered scopes and restores them after restart', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, {
      method: 'POST',
      body: JSON.stringify(makeLog({ scope: 'checkout' })),
    });

    const scopesPath = path.join(dir, '.tracelink', 'scopes.json');
    await waitFor(() => existsSync(scopesPath));
    const persisted = JSON.parse(await fs.readFile(scopesPath, 'utf-8'));
    expect(persisted).toEqual({ enabled: ['*'], known: ['checkout'] });

    const restarted = createReceiverHandler({ dir });
    const response = await callHandler(restarted, {
      method: 'GET',
      url: '/__debug_log/scopes',
    });
    expect(JSON.parse(response.body)).toEqual({ enabled: ['*'], known: ['checkout'] });
  });

  it('loads an older scopes file without a known catalog', async () => {
    const logDir = path.join(dir, '.tracelink');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, 'scopes.json'),
      JSON.stringify({ enabled: ['delete-work'] }),
      'utf-8',
    );

    const handler = createReceiverHandler({ dir });
    const response = await callHandler(handler, {
      method: 'GET',
      url: '/__debug_log/scopes',
    });
    expect(JSON.parse(response.body)).toEqual({ enabled: ['delete-work'], known: [] });
  });

  it('GET /ui serves the embedded dashboard HTML', async () => {
    const handler = createReceiverHandler({ dir, persistScopes: false });
    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log/ui' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>');
  });

  it('collects known scopes from POSTed logs', async () => {
    const handler = createReceiverHandler({ dir, persistScopes: false });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ scope: 'delete-work' })) });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ scope: 'card-create' })) });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ scope: 'delete-work' })) });

    const res = await callHandler(handler, { method: 'GET', url: '/__debug_log/scopes' });
    const known: string[] = JSON.parse(res.body).known;
    expect(known.sort()).toEqual(['card-create', 'delete-work']);
  });

  it('DELETE /scopes resets the persisted catalog and enables discovery', async () => {
    const handler = createReceiverHandler({ dir });
    await callHandler(handler, {
      method: 'POST',
      url: '/__debug_log/scopes',
      body: JSON.stringify({ enabled: ['delete-work'] }),
    });
    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ scope: 'delete-work' })) });

    const cleared = await callHandler(handler, { method: 'DELETE', url: '/__debug_log/scopes' });
    expect(cleared.statusCode).toBe(204);

    const afterClear = await callHandler(handler, { method: 'GET', url: '/__debug_log/scopes' });
    expect(JSON.parse(afterClear.body)).toEqual({ enabled: ['*'], known: [] });

    const persisted = JSON.parse(
      await fs.readFile(path.join(dir, '.tracelink', 'scopes.json'), 'utf-8'),
    );
    expect(persisted).toEqual({ enabled: ['*'], known: [] });

    await callHandler(handler, { method: 'POST', body: JSON.stringify(makeLog({ scope: 'delete-work' })) });
    const afterNextLog = await callHandler(handler, { method: 'GET', url: '/__debug_log/scopes' });
    expect(JSON.parse(afterNextLog.body).known).toEqual(['delete-work']);
  });
});

describe('startReceiverServer', () => {
  let dir: string;
  let server: http.Server | undefined;
  let extra: http.Server[] = [];

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `tracelink-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    extra = [];
  });

  afterEach(async () => {
    for (const s of [server, ...extra]) {
      if (s && s.listening) await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    server = undefined;
    extra = [];
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('listens, accepts a POST, writes the file, and closes', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    const log = makeLog({ msg: 'via-server' });
    const postRes = await fetch(`http://127.0.0.1:${port}/__debug_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    expect(postRes.status).toBe(204);
    expect(postRes.headers.get('x-tracelink-receiver')).toBe(TRACE_PROTOCOL_VERSION);

    const ndjsonPath = path.join(dir, '.tracelink', 'trace.ndjson');
    const content = await fs.readFile(ndjsonPath, 'utf-8');
    expect(JSON.parse(content.trim()).msg).toBe('via-server');

    const getRes = await fetch(`http://127.0.0.1:${port}/__debug_log`);
    const body = await getRes.text();
    expect(body).toContain('via-server');
  });

  it('SSE /stream pushes newly POSTed logs to a live subscriber', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    const received: string[] = [];
    const sseReq = http.request(
      { host: '127.0.0.1', port, path: '/__debug_log/stream', method: 'GET' },
      (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf-8');
        res.on('data', (c: string) => received.push(c));
      },
    );
    sseReq.end();

    await delay(150); // let the SSE connection register

    await fetch(`http://127.0.0.1:${port}/__debug_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeLog({ msg: 'streamed', scope: 'delete-work' })),
    });

    await waitFor(() => received.join('').includes('streamed'));
    const all = received.join('');
    expect(all).toContain('event: log');
    expect(all).toContain('"msg":"streamed"');

    sseReq.destroy();
  });

  it('SSE /scopes/stream sends the current policy and pushes updates', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    const received: string[] = [];
    const sseReq = http.request(
      { host: '127.0.0.1', port, path: '/__debug_log/scopes/stream', method: 'GET' },
      (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => received.push(chunk));
      },
    );
    sseReq.end();

    await waitFor(() => received.join('').includes('"revision":0'));
    expect(received.join('')).toContain('"enabled":["*"]');

    await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: ['delete-work'] }),
    });

    await waitFor(() => received.join('').includes('"revision":1'));
    const all = received.join('');
    expect(all).toContain('event: scopes');
    expect(all).toContain('"enabled":["delete-work"]');
    expect(all).not.toContain('event: replay');
    expect(all).not.toContain('event: log');

    await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`, { method: 'DELETE' });
    await waitFor(() => received.join('').includes('"revision":2'));
    const resetFrame = received
      .join('')
      .split('\n')
      .find((line) => line.startsWith('data:') && line.includes('"revision":2'))!;
    expect(JSON.parse(resetFrame.slice('data:'.length)).enabled).toEqual(['*']);

    sseReq.destroy();
  });

  it('passes new fields (outcome/durationMs/async/level) through POST -> stream round-trip', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    const received: string[] = [];
    const sseReq = http.request(
      { host: '127.0.0.1', port, path: '/__debug_log/stream', method: 'GET' },
      (res) => {
        res.setEncoding('utf-8');
        res.on('data', (c: string) => received.push(c));
      },
    );
    sseReq.end();

    await delay(150); // let the SSE connection register

    const log = makeLog({
      msg: 'round-trip-fields',
      level: 'warn',
      outcome: 'blocked',
      durationMs: 123,
      async: true,
      data: { reason: 'insufficient permission' },
    });
    await fetch(`http://127.0.0.1:${port}/__debug_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });

    await waitFor(() => received.join('').includes('round-trip-fields'));

    // Parse the streamed SSE payload back into an object and assert the new
    // optional fields survived the schema-agnostic receiver unchanged.
    const frame = received
      .join('')
      .split('\n')
      .find((l) => l.startsWith('data:') && l.includes('round-trip-fields'))!;
    const streamed = JSON.parse(frame.slice('data:'.length).trim()) as TraceLog;
    expect(streamed.level).toBe('warn');
    expect(streamed.outcome).toBe('blocked');
    expect(streamed.durationMs).toBe(123);
    expect(streamed.async).toBe(true);
    expect((streamed.data as Record<string, unknown>).reason).toBe('insufficient permission');

    // Also confirm persistence to NDJSON kept the fields.
    const ndjson = await fs.readFile(path.join(dir, '.tracelink', 'trace.ndjson'), 'utf-8');
    const persisted = JSON.parse(ndjson.trim().split('\n').pop()!) as TraceLog;
    expect(persisted.outcome).toBe('blocked');
    expect(persisted.durationMs).toBe(123);
    expect(persisted.async).toBe(true);
    expect(persisted.level).toBe('warn');

    sseReq.destroy();
  });

  it('SSE replays the existing buffer on connect', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    await fetch(`http://127.0.0.1:${port}/__debug_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeLog({ msg: 'buffered-before-connect' })),
    });
    await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`, { method: 'DELETE' });

    const received: string[] = [];
    const sseReq = http.request(
      { host: '127.0.0.1', port, path: '/__debug_log/stream', method: 'GET' },
      (res) => {
        res.setEncoding('utf-8');
        res.on('data', (c: string) => received.push(c));
      },
    );
    sseReq.end();

    await waitFor(() => received.join('').includes('buffered-before-connect'));
    expect(received.join('')).toContain('event: replay');

    const scopes = await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`);
    expect(await scopes.json()).toEqual({ enabled: ['*'], known: [] });
    sseReq.destroy();
  });

  it('scopes round-trip over the wire (POST then GET)', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1', persistScopes: false });
    await waitListening(server);
    const port = listeningPort(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: ['delete-work'] }),
    });
    expect(postRes.status).toBe(204);

    const getRes = await fetch(`http://127.0.0.1:${port}/__debug_log/scopes`);
    const body = (await getRes.json()) as { enabled: string[] };
    expect(body.enabled).toEqual(['delete-work']);
  });

  it('POST /__tracelink/shutdown closes the server with an active SSE client', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    const stream = await fetch(`http://127.0.0.1:${port}/__debug_log/stream`);
    expect(stream.status).toBe(200);
    const closed = new Promise<void>((resolve) => server!.once('close', () => resolve()));

    const res = await fetch(`http://127.0.0.1:${port}/__tracelink/shutdown`, { method: 'POST' });
    expect(res.status).toBe(204);

    await Promise.race([
      closed,
      delay(2000).then(() => {
        throw new Error('receiver did not close active SSE connections');
      }),
    ]);
    expect(server!.listening).toBe(false);
  });

  it('reuses an existing TraceLink receiver instead of double-binding', async () => {
    server = startReceiverServer({ dir, port: 0, host: '127.0.0.1' });
    await waitListening(server);
    const port = listeningPort(server);

    // Second start on the same port should detect "one of us" and reuse.
    const second = startReceiverServer({ dir, port, host: '127.0.0.1' });
    extra.push(second);

    await delay(400); // allow the async probe + reuse decision to settle
    expect(second.listening).toBe(false);
    expect(server.listening).toBe(true);
  });

  it('reuses a Receiver that reports a historical compatible protocol alias', async () => {
    const legacy = http.createServer((_req, res) => {
      res.setHeader('x-tracelink-receiver', '0.5.0');
      res.end('{}');
    });
    extra.push(legacy);
    legacy.listen(0, '127.0.0.1');
    await waitListening(legacy);
    const port = listeningPort(legacy);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const candidate = startReceiverServer({ dir, port, host: '127.0.0.1' });
      extra.push(candidate);
      await delay(400);

      expect(candidate.listening).toBe(false);
      expect(legacy.listening).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('compatible TraceLink protocol 0.5.0'));
    } finally {
      log.mockRestore();
    }
  });

  it('does not reuse a TraceLink receiver with an incompatible protocol', async () => {
    const legacy = http.createServer((_req, res) => {
      res.setHeader('x-tracelink-receiver', 'legacy');
      res.end('{}');
    });
    extra.push(legacy);
    legacy.listen(0, '127.0.0.1');
    await waitListening(legacy);
    const port = listeningPort(legacy);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const candidate = startReceiverServer({ dir, port, host: '127.0.0.1' });
      extra.push(candidate);
      await delay(400);

      expect(candidate.listening).toBe(false);
      expect(legacy.listening).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('requires protocol'));
    } finally {
      error.mockRestore();
    }
  });
});
