/**
 * Vite plugin — bridges browser trace events to local files.
 *
 * **RECEIVER** — Vite middleware tool.
 * Dimension: receiver · tool axis (how the debug server is built: Vite middleware)
 *
 * Endpoints:
 *   POST   /__debug_log        — write event → 204
 *   GET    /__debug_log        — read NDJSON
 *   GET    /__debug_log?report — read with head/tail summary
 *   DELETE /__debug_log        — clear both files → 204
 *   GET    /__debug_log/stream — SSE live push
 *   GET    /__debug_log/scopes — authoritative + known scopes
 *   POST   /__debug_log/scopes — set authoritative scopes → 204
 *   GET    /__debug_log/scopes/stream — live authoritative Scope policy
 */

import type { Plugin } from 'vite';
import type { DebugLogPluginOptions } from './types.js';
import { createReceiverHandler } from '../../service/handler.js';

export function debugLogPlugin(options: DebugLogPluginOptions = {}): Plugin {
  return {
    name: 'tracelink:debug-log',
    apply: 'serve', // dev server only

    configureServer(server) {
      // Dynamically resolve options based on Vite server config
      const resolvedOptions = {
        ...options,
        dir: options.dir ?? server.config.root ?? process.cwd(),
      };

      const handler = createReceiverHandler(resolvedOptions);

      // Mount the receiver handler on /__debug_log path
      server.middlewares.use('/__debug_log', async (req, res, next) => {
        try {
          await handler(req, res, next);
        } catch {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end('internal server error');
          }
        }
      });
    },
  };
}
