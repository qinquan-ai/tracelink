/**
 * Console exporter — pretty-prints with per-layer colors.
 */

import type { TraceLayer, TraceLog } from '../../engine/types.js';

const COLORS: Record<TraceLayer, string> = {
  'FE-ACTION': 'color:#4CAF50;font-weight:bold',
  'FE-API': 'color:#2196F3;font-weight:bold',
  'FE-WS': 'color:#9C27B0;font-weight:bold',
  'FE-UI': 'color:#FF9800;font-weight:bold',
  'BE-ENTRY': 'color:#E91E63;font-weight:bold',
  'BE-INTERNAL': 'color:#607D8B;font-weight:bold',
  'BE-DB': 'color:#795548;font-weight:bold',
  'BE-WS': 'color:#9C27B0;font-weight:bold',
};

export function consoleExporter(log: TraceLog): void {
  const style = COLORS[log.layer] ?? '';
  try {
    // eslint-disable-next-line no-console
    console.log(`%c[${log.ts}][${log.layer}][${log.fn}] ${log.msg}`, style, log.data);
  } catch {
    // ignore console errors in edge environments
  }
}
