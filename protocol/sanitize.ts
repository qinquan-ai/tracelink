/** Shared JavaScript implementation of the protocol's bounded-data rule. */

const MAX_STRING = 300;
const MAX_STRING_HEAD = 150;
const MAX_DEPTH = 10;
const MAX_ITEMS = 50;

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max depth]';

  if (typeof value === 'string') {
    if (value.startsWith('data:image') || value.startsWith('data:video')) {
      return value.slice(0, 50) + '...[truncated]';
    }
    if (value.length > MAX_STRING) {
      return value.slice(0, MAX_STRING_HEAD) + `...[${value.length} chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS);
    return Object.fromEntries(
      entries.map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  }

  return value;
}

export function sanitizeData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  return (sanitize(data) ?? {}) as Record<string, unknown>;
}
