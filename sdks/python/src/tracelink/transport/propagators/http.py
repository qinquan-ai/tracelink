"""Encode and decode TraceLink context on application HTTP requests."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from ...runtime.context import current_span, current_trace_id

TRACE_ID_HEADER = "x-trace-id"
PARENT_SPAN_ID_HEADER = "x-parent-span-id"
SCOPES_HEADER = "x-debug-scopes"


@dataclass(frozen=True)
class PropagatedContext:
    trace_id: str | None
    parent_span_id: str | None
    scopes: frozenset[str] | None


def _read_header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            normalized = value.strip()
            return normalized or None
    return None


def parse_scopes_header(value: str | None) -> frozenset[str] | None:
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    return frozenset(str(scope).strip() for scope in parsed if str(scope).strip())


def extract_trace_context(headers: Mapping[str, str]) -> PropagatedContext:
    trace_id = _read_header(headers, TRACE_ID_HEADER)
    return PropagatedContext(
        trace_id=trace_id,
        parent_span_id=_read_header(headers, PARENT_SPAN_ID_HEADER),
        scopes=parse_scopes_header(_read_header(headers, SCOPES_HEADER)),
    )


def inject_trace_headers(
    headers: Mapping[str, str] | None = None,
    *,
    trace_id: str | None = None,
    parent_span_id: str | None = None,
    scopes: Iterable[str] | None = None,
) -> dict[str, str]:
    result = dict(headers or {})
    lower_names = {name.lower() for name in result}
    if trace_id and TRACE_ID_HEADER not in lower_names:
        result[TRACE_ID_HEADER] = trace_id
    if parent_span_id and PARENT_SPAN_ID_HEADER not in lower_names:
        result[PARENT_SPAN_ID_HEADER] = parent_span_id
    if scopes is not None and SCOPES_HEADER not in lower_names:
        scope_values = [scopes] if isinstance(scopes, str) else scopes
        normalized = list(dict.fromkeys(str(scope).strip() for scope in scope_values))
        result[SCOPES_HEADER] = json.dumps(
            [scope for scope in normalized if scope], separators=(",", ":")
        )
    return result


def create_trace_headers(
    headers: Mapping[str, str] | None = None,
    *,
    trace_id: str | None = None,
    parent_span_id: str | None = None,
    scopes: Iterable[str] | None = None,
) -> dict[str, str]:
    """Build business-request headers from the active Python SDK context."""
    span = current_span()
    if scopes is None:
        from ...engine.tracer import tracer

        scopes = tracer.get_enabled_scopes()
    resolved_trace_id = trace_id or (span.trace_id if span else current_trace_id())
    can_inherit_span = span is not None and (
        trace_id is None or trace_id == span.trace_id
    )
    return inject_trace_headers(
        headers,
        trace_id=resolved_trace_id,
        parent_span_id=parent_span_id or (
            span.span_id if can_inherit_span and span is not None else None
        ),
        scopes=scopes,
    )
