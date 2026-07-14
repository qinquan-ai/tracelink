import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import type { TraceLog } from '../../protocol/types.js';
import { sanitizeData } from '../../protocol/sanitize.js';

/**
 * Absolute path to the embedded dashboard single-file bundle. Resolved relative
 * to this module so it works both from source (`src/receiver/core.ts`, under
 * vitest) and from the built bundle (`dist/receiver/http.js`) — both sit two
 * levels below the package root, where `dashboard/index.html` is shipped.
 * The asset is produced by `scripts/embed-dashboard.mjs` (copied from the
 * separate debug_board repo's `build:single` output).
 */
function findPackageRoot(startUrl: string): string {
  let dir = path.dirname(fileURLToPath(startUrl));
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'tracelink') {
          return dir;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.dirname(fileURLToPath(startUrl));
}

const DASHBOARD_HTML_PATH = path.join(
  findPackageRoot(import.meta.url),
  'dashboard/index.html',
);

/**
 * Receiver protocol version. Sent on every response as `x-tracelink-receiver`
 * so peers (dashboards, other receivers) can identify a TraceLink server and
 * so `startReceiverServer` can tell "one of us" apart from a foreign process
 * holding the port.
 */
export const RECEIVER_VERSION = '0.5.0';

export interface ReceiverOptions {
  /** Override project root (default: process.cwd()). Logs live in `<dir>/<subdir>`. */
  dir?: string;
  /** Log subdirectory (default: '.tracelink'). */
  subdir?: string;
  /** Access-Control-Allow-Origin value (default: '*'). */
  cors?: string;
  /** Persist authoritative scope config to `.tracelink/scopes.json` (default: true). */
  persistScopes?: boolean;
}

/** NDJSON — machine-readable, one JSON TraceLog per line. */
const NDJSON_FILE = 'trace.ndjson';
/** Human-readable multi-line log. */
const READABLE_FILE = 'trace.log';
/** Authoritative scope config persistence. */
const SCOPES_FILE = 'scopes.json';
/** SSE keep-alive comment interval. */
const HEARTBEAT_MS = 15_000;
/** Coalesce newly discovered Scope names before persisting the catalog. */
const SCOPE_PERSIST_DEBOUNCE_MS = 100;

interface ScopesState {
  enabled: string[];
  known: string[];
}

function formatReadable(log: TraceLog): string {
  const lines: string[] = [];
  lines.push(`${log.ts} [${log.layer}] [${log.fn}]`);
  lines.push(`  > ${log.msg}`);
  if (log.data && Object.keys(log.data).length > 0) {
    lines.push('  > data:');
    const json = JSON.stringify(log.data, null, 2).split('\n');
    for (const line of json) lines.push(`    ${line}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * Resolve the request path down to a receiver sub-route, tolerating both
 * mounting styles:
 *   - root-mounted (standalone `node:http` server): '/__debug_log', '/__debug_log/stream'
 *   - path-mounted (Vite `middlewares.use('/__debug_log', ...)`, which strips
 *     the mount prefix): '/', '/stream', '/scopes', '/scopes/stream'
 * Returns a receiver sub-route or the original (unhandled) path.
 */
function resolveSubRoute(pathname: string): string {
  if (pathname === '/__debug_log') return '/';
  if (pathname.startsWith('/__debug_log/')) return pathname.slice('/__debug_log'.length);
  return pathname;
}

export function createReceiverHandler(options: ReceiverOptions = {}) {
  const projectRoot = options.dir ?? process.cwd();
  const subdir = options.subdir ?? '.tracelink';
  const cors = options.cors ?? '*';
  const persistScopes = options.persistScopes ?? true;

  const logDir = path.join(projectRoot, subdir);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const ndjsonPath = path.join(logDir, NDJSON_FILE);
  const readablePath = path.join(logDir, READABLE_FILE);
  const scopesPath = path.join(logDir, SCOPES_FILE);

  // ---- in-memory state (per-handler instance) ------------------------------
  /** Live SSE subscribers. Each new log fans out to all of them. */
  const subscribers = new Set<ServerResponse>();
  /** Scope-control SSE subscribers. They receive policy snapshots only. */
  const scopeSubscribers = new Set<ServerResponse>();
  /** Every scope name ever seen flowing through this receiver (deduped). */
  const knownScopes = new Set<string>();
  /** Authoritative enabled-scope config. `['*']` = all. */
  let enabledScopes: string[] = ['*'];
  let scopeRevision = 0;
  let scopePersistTimer: ReturnType<typeof setTimeout> | undefined;
  let scopePersistQueue = Promise.resolve();

  // Rehydrate persisted scope config and catalog if present. Older files that
  // only contain `enabled` remain valid and start with an empty catalog.
  if (persistScopes && existsSync(scopesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(scopesPath, 'utf-8')) as Partial<ScopesState>;
      if (Array.isArray(parsed.enabled)) enabledScopes = parsed.enabled.map(String);
      if (Array.isArray(parsed.known)) {
        for (const scope of parsed.known) {
          const normalized = String(scope).trim();
          if (normalized) knownScopes.add(normalized);
        }
      }
    } catch {
      // ignore malformed persisted config — fall back to ['*']
    }
  }

  function persistScopeState(): Promise<void> {
    if (!persistScopes) return Promise.resolve();

    const snapshot: ScopesState = {
      enabled: [...enabledScopes],
      known: Array.from(knownScopes).sort(),
    };
    const tempPath = `${scopesPath}.${process.pid}.tmp`;

    scopePersistQueue = scopePersistQueue.then(async () => {
      try {
        await fs.writeFile(tempPath, JSON.stringify(snapshot), 'utf-8');
        try {
          await fs.rename(tempPath, scopesPath);
        } catch {
          // Windows may reject replacing an existing file via rename.
          await fs.rm(scopesPath, { force: true });
          await fs.rename(tempPath, scopesPath);
        }
      } catch {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        // Persistence is best-effort; in-memory state remains authoritative.
      }
    });

    return scopePersistQueue;
  }

  function scheduleScopePersistence(): void {
    if (!persistScopes) return;
    if (scopePersistTimer) clearTimeout(scopePersistTimer);
    scopePersistTimer = setTimeout(() => {
      scopePersistTimer = undefined;
      void persistScopeState();
    }, SCOPE_PERSIST_DEBOUNCE_MS);
    if (typeof (scopePersistTimer as { unref?: () => void }).unref === 'function') {
      (scopePersistTimer as { unref: () => void }).unref();
    }
  }

  function setCommonHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', cors);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'content-type, x-trace-id, x-parent-span-id, x-debug-scopes',
    );
    res.setHeader('x-tracelink-receiver', RECEIVER_VERSION);
  }

  /** Fan a freshly-written log out to all live SSE subscribers. */
  function publish(log: TraceLog): void {
    if (subscribers.size === 0) return;
    const payload = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
    for (const sub of subscribers) {
      try {
        sub.write(payload);
      } catch {
        // a broken subscriber will be cleaned up on its own 'close' event
      }
    }
  }

  function publishScopes(): void {
    if (scopeSubscribers.size === 0) return;
    const payload = `event: scopes\ndata: ${JSON.stringify({
      enabled: enabledScopes,
      revision: scopeRevision,
    })}\n\n`;
    for (const subscriber of scopeSubscribers) {
      try {
        subscriber.write(payload);
      } catch {
        // cleanup is handled by the connection's close event
      }
    }
  }

  function collectScope(log: TraceLog): void {
    if (!log.scope || knownScopes.has(log.scope)) return;
    knownScopes.add(log.scope);
    scheduleScopePersistence();
  }

  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = resolveSubRoute(url.pathname);

    const isOurs =
      route === '/' ||
      route === '/stream' ||
      route === '/scopes' ||
      route === '/scopes/stream' ||
      route === '/ui';
    if (!isOurs) {
      if (next) {
        next();
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
      return;
    }

    // Every response we own carries CORS + identity headers.
    setCommonHeaders(res);

    // CORS preflight — answer for any of our routes.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // ---- /ui (serve the embedded dashboard) --------------------------------
    // Same-origin HTML: the CORS headers above are harmless here, and serving
    // the bundle from the receiver that produced the logs means the dashboard's
    // origin-aware default base "just works" with zero config.
    if (route === '/ui') {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      try {
        const html = await fs.readFile(DASHBOARD_HTML_PATH, 'utf-8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      } catch {
        // Asset missing (e.g. installed without the dashboard/ dir). Fail with a
        // friendly, actionable message rather than a bare 500.
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(
          'dashboard asset not bundled — expected dashboard/index.html in the package. ' +
            'Rebuild it in debug_board (`npm run build:single`), then run ' +
            '`node scripts/embed-dashboard.mjs` from the repo root.',
        );
      }
      return;
    }

    // ---- /scopes -----------------------------------------------------------
    if (route === '/scopes/stream') {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
        (res as { flushHeaders: () => void }).flushHeaders();
      }

      scopeSubscribers.add(res);
      res.write(`event: scopes\ndata: ${JSON.stringify({
        enabled: enabledScopes,
        revision: scopeRevision,
      })}\n\n`);

      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          // cleanup is handled below
        }
      }, HEARTBEAT_MS);
      if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
        (heartbeat as { unref: () => void }).unref();
      }

      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        scopeSubscribers.delete(res);
      };
      req.once('close', cleanup);
      res.once('close', cleanup);
      res.once('finish', cleanup);
      return;
    }

    if (route === '/scopes') {
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ enabled: enabledScopes, known: Array.from(knownScopes) }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body) as ScopesState;
            if (!Array.isArray(parsed.enabled)) {
              res.statusCode = 400;
              res.end('expected { enabled: string[] }');
              return;
            }
            enabledScopes = parsed.enabled.map(String);
            scopeRevision += 1;
            await persistScopeState();
            publishScopes();
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end('bad json');
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        knownScopes.clear();
        enabledScopes = ['*'];
        scopeRevision += 1;
        if (scopePersistTimer) {
          clearTimeout(scopePersistTimer);
          scopePersistTimer = undefined;
        }
        await persistScopeState();
        publishScopes();
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    // ---- /stream (Server-Sent Events) --------------------------------------
    if (route === '/stream') {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Hint reverse proxies (nginx) not to buffer the stream.
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
        (res as { flushHeaders: () => void }).flushHeaders();
      }

      // Replay uses a distinct event type so consumers can separate historical
      // rows from live discovery. Replayed logs never mutate the Scope catalog.
      try {
        if (existsSync(ndjsonPath)) {
          const content = await fs.readFile(ndjsonPath, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            res.write(`event: replay\ndata: ${line}\n\n`);
          }
        }
      } catch {
        // replay is best-effort
      }

      subscribers.add(res);

      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          // ignore; cleanup handled on close
        }
      }, HEARTBEAT_MS);
      if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
        (heartbeat as { unref: () => void }).unref();
      }

      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        subscribers.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      // Keep the connection open — do NOT end the response.
      return;
    }

    // ---- / (main log endpoint) ---------------------------------------------
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const log = JSON.parse(body) as TraceLog;
          // Sanitize data on the server side as a defensive measure.
          log.data = sanitizeData(log.data);

          await fs.appendFile(ndjsonPath, JSON.stringify(log) + '\n', 'utf-8');
          await fs.appendFile(readablePath, formatReadable(log), 'utf-8');

          collectScope(log);
          publish(log);

          res.statusCode = 204;
          res.end();
        } catch {
          res.statusCode = 400;
          res.end('bad json');
        }
      });
      return;
    }

    if (req.method === 'GET') {
      try {
        if (url.searchParams.has('report')) {
          const content = existsSync(readablePath)
            ? await fs.readFile(readablePath, 'utf-8')
            : '';
          const lines = content.split('\n').filter(Boolean);
          const head = lines.slice(0, 20).join('\n');
          const tail = lines.slice(-50).join('\n');

          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(`=== HEAD (first 20) ===\n${head}\n\n=== TAIL (last 50) ===\n${tail}`);
        } else {
          // Redirect browser requests (Accept: text/html) to the UI page instead of triggering a download.
          const accept = req.headers['accept'] || '';
          if (accept.includes('text/html') && route === '/') {
            res.statusCode = 302;
            res.setHeader('Location', '/__debug_log/ui');
            res.end();
            return;
          }

          const content = existsSync(ndjsonPath)
            ? await fs.readFile(ndjsonPath, 'utf-8')
            : '';

          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          res.end(content);
        }
      } catch {
        res.statusCode = 500;
        res.end('read failed');
      }
      return;
    }

    if (req.method === 'DELETE') {
      try {
        if (existsSync(ndjsonPath)) await fs.unlink(ndjsonPath);
        if (existsSync(readablePath)) await fs.unlink(readablePath);
        res.statusCode = 204;
        res.end();
      } catch {
        res.statusCode = 500;
        res.end('delete failed');
      }
      return;
    }

    // Unhandled method on an owned path.
    if (next) {
      next();
    } else {
      res.statusCode = 405;
      res.end('Method Not Allowed');
    }
  };
}
