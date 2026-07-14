"""Data sanitization for TraceLink Python."""

from __future__ import annotations

from typing import Any

MAX_DEPTH = 10
MAX_STRING = 300
MAX_STRING_HEAD = 150
MAX_ITEMS = 50


def _sanitize_value(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return "[max depth]"

    if isinstance(value, str):
        # Truncate base64 data URLs
        if value.startswith("data:image") or value.startswith("data:video"):
            return value[:50] + "...[truncated]"
        # Truncate long strings
        if len(value) > MAX_STRING:
            return value[:MAX_STRING_HEAD] + f"...[{len(value)} chars]"
        return value

    if isinstance(value, list):
        return [_sanitize_value(item, depth + 1) for item in value[:MAX_ITEMS]]

    if isinstance(value, dict):
        items = list(value.items())[:MAX_ITEMS]
        return {k: _sanitize_value(v, depth + 1) for k, v in items}

    return value


def sanitize_data(data: dict[str, Any] | None) -> dict[str, Any]:
    if not data:
        return {}
    return _sanitize_value(data) or {}
