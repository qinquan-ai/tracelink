/**
 * Time helpers — millisecond timestamp + formatted local time string.
 */

export function now(): number {
  return Date.now();
}

export function formatTs(ts = now()): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `[${h}:${m}:${s}.${ms}]`;
}

/** Generate a traceId with the format `<scope>-<timestamp6>-<rand3>`. */
export function makeTraceId(scope: string): string {
  const ts = String(now()).slice(-6);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${scope}-${ts}-${rand}`;
}

/** Generate a spanId like `span-3`. */
let spanCounter = 0;
export function makeSpanId(): string {
  return `span-${++spanCounter}`;
}
