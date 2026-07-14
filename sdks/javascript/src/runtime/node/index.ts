/**
 * tracelink-node public entry.
 *
 * Complete Node.js runtime profile: shared tracing engine, async-correct
 * context, and the Node HTTP exporter.
 */

import { installNodeAsyncContext } from './context.js';

export * from '../../index.js';

export { NodeHttpExporter } from '../../transport/exporters/node-http.js';
export type { NodeHttpExporterOptions } from '../../transport/exporters/node-http.js';

export { AlsContextProvider, installNodeAsyncContext } from './context.js';

// Side-effect: importing the Node entry opts you into async-correct span
// context (AsyncLocalStorage) automatically. Safe here — this module is only
// in the Node build, so `node:async_hooks` never reaches the browser bundle.
installNodeAsyncContext();
