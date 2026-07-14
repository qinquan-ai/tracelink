/**
 * tracelink-browser public entry.
 *
 * Complete browser runtime profile: shared tracing engine, browser HTTP
 * exporter, and optional DOM instrumentation.
 */

export * from '../../index.js';

export { BrowserHttpExporter } from '../../transport/exporters/browser-http.js';
export type { BrowserHttpExporterOptions } from '../../transport/exporters/browser-http.js';

export {
  installAutoClick,
  disableAutoClick,
  enableAutoClick,
} from '../../extensions/instrumentations/dom-click.js';
