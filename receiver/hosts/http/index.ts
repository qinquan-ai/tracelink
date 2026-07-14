import http from 'node:http';
import { isTraceProtocolCompatible } from '../../../protocol/version.js';
import {
  createReceiverHandler,
  ReceiverOptions,
  RECEIVER_VERSION,
  TRACE_PROTOCOL_VERSION,
} from '../../service/handler.js';

export { createReceiverHandler, RECEIVER_VERSION, TRACE_PROTOCOL_VERSION };
export type { ReceiverOptions };

export interface ReceiverServerOptions extends ReceiverOptions {
  /** Port to listen on (default: TRACELINK_PORT env, else 5174). */
  port?: number;
  /** Host to bind to (default: '127.0.0.1'). */
  host?: string;
  /**
   * When the port is already held by another TraceLink receiver, ask it to
   * shut down and take over instead of reusing it. No effect on foreign
   * processes (those always produce an actionable error, never a kill).
   */
  force?: boolean;
}

/** Local-only graceful shutdown endpoint (used by `force` restarts). */
const SHUTDOWN_PATH = '/__tracelink/shutdown';

type ReceiverProbe =
  | { kind: 'foreign' }
  | { kind: 'compatible'; version: string }
  | { kind: 'incompatible'; version: string };

/** GET a candidate port and identify its TraceLink protocol generation. */
function probeReceiver(port: number, host: string, timeoutMs = 500): Promise<ReceiverProbe> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, method: 'GET', path: '/__debug_log/scopes', timeout: timeoutMs },
      (res) => {
        const header = res.headers['x-tracelink-receiver'];
        const version = Array.isArray(header) ? header[0] : header;
        res.resume();
        if (!version) {
          resolve({ kind: 'foreign' });
        } else if (isTraceProtocolCompatible(version)) {
          resolve({ kind: 'compatible', version });
        } else {
          resolve({ kind: 'incompatible', version });
        }
      },
    );
    req.on('error', () => resolve({ kind: 'foreign' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ kind: 'foreign' });
    });
    req.end();
  });
}

/** Ask an existing TraceLink receiver to shut itself down. Best-effort. */
function requestShutdown(port: number, host: string, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, method: 'POST', path: SHUTDOWN_PATH, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start a standalone HTTP receiver server using the native Node.js http module.
 * Useful for debugging Node.js, Next.js, and other non-Vite development
 * environments.
 *
 * Port management:
 *   - `port` defaults to `process.env.TRACELINK_PORT` then 5174.
 *   - On `EADDRINUSE`, we probe the occupant:
 *       · it's another TraceLink receiver → reuse it (log + no-op) unless
 *         `force`, in which case we ask it to shut down and retry.
 *       · it's a foreign process → throw an actionable error. We never kill
 *         foreign processes.
 *   - SIGINT/SIGTERM close the server so no zombie port is left behind.
 */
export function startReceiverServer(options: ReceiverServerOptions = {}): http.Server {
  const envPort = process.env.TRACELINK_PORT ? Number(process.env.TRACELINK_PORT) : NaN;
  const port = options.port ?? (Number.isFinite(envPort) ? envPort : 5174);
  const host = options.host ?? '127.0.0.1';
  const handler = createReceiverHandler(options);

  const server = http.createServer(async (req, res) => {
    // Local-only graceful shutdown hook (used by force restarts).
    if (req.method === 'POST' && req.url === SHUTDOWN_PATH) {
      res.setHeader('x-tracelink-receiver', TRACE_PROTOCOL_VERSION);
      res.statusCode = 204;
      res.end();
      // Close after the response has been flushed.
      setImmediate(shutdown);
      return;
    }
    // Convenience redirect: bare root → the embedded dashboard. Only applies to
    // the standalone server (where '/' is truly the root); the Vite middleware
    // mount, where '/' means '/__debug_log', is untouched.
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.statusCode = 302;
      res.setHeader('Location', '/__debug_log/ui');
      res.end();
      return;
    }
    try {
      await handler(req, res);
    } catch {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end('internal server error');
      }
    }
  });

  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EADDRINUSE') {
      throw err;
    }
    void (async () => {
      const probe = await probeReceiver(port, host);
      if (probe.kind === 'foreign') {
        const msg =
          `[TraceLink] Port ${port} is already in use by a non-TraceLink process. ` +
          `TraceLink will not kill it. Free the port, or pass a different one via ` +
          `startReceiverServer({ port }) or the TRACELINK_PORT env var.`;
        console.error(msg);
        throw new Error(msg);
      }
      if (probe.kind === 'incompatible' && !options.force) {
        console.error(
          `[TraceLink] Port ${port} is held by TraceLink protocol ${probe.version}, ` +
          `but this release requires protocol ${TRACE_PROTOCOL_VERSION}. ` +
          `Use { force: true } to replace it, or choose another port.`,
        );
        return;
      }
      if (options.force) {
        console.log(
          `[TraceLink] Port ${port} held by TraceLink protocol ${probe.version}; ` +
          `force restart requested — asking it to shut down...`,
        );
        await requestShutdown(port, host);
        await delay(300);
        server.listen(port, host);
        return;
      }
      console.log(
        `[TraceLink] A compatible TraceLink protocol ${probe.version} receiver is already running ` +
        `at http://${host}:${port}/__debug_log — reusing it (pass { force: true } to restart).`,
      );
    })();
  };
  server.on('error', onError);

  server.listen(port, host, () => {
    console.log(`[TraceLink] Debug receiver server listening at http://${host}:${port}/__debug_log`);
  });

  // Avoid zombie ports on Ctrl-C / kill. Listeners are removed when the server
  // closes so long-lived processes (and test suites spawning many servers)
  // don't accumulate signal handlers.
  const shutdown = (): void => {
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // already closing/closed
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('close', () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });

  return server;
}
