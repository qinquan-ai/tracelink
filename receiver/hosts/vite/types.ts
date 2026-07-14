/**
 * TypeScript mirror of the language-neutral protocol for Vite host consumers.
 */
export type { TraceLog } from '../../../protocol/types.js';

export interface DebugLogPluginOptions {
  /** Override log directory (default: <projectRoot>) */
  dir?: string;
  /** Log subdirectory (default: '.tracelink') */
  subdir?: string;
  /** Access-Control-Allow-Origin value (default: '*') */
  cors?: string;
  /** Persist authoritative scope config to `.tracelink/scopes.json` (default: true) */
  persistScopes?: boolean;
}
