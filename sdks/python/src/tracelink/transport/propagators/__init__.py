"""Cross-process trace context propagation."""

from .http import (
    PARENT_SPAN_ID_HEADER,
    SCOPES_HEADER,
    TRACE_ID_HEADER,
    PropagatedContext,
    create_trace_headers,
    extract_trace_context,
    inject_trace_headers,
    parse_scopes_header,
)

__all__ = [
    "PARENT_SPAN_ID_HEADER",
    "SCOPES_HEADER",
    "TRACE_ID_HEADER",
    "PropagatedContext",
    "create_trace_headers",
    "extract_trace_context",
    "inject_trace_headers",
    "parse_scopes_header",
]
