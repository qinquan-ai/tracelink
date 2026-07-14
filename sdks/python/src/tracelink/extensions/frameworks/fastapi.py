"""FastAPI / Starlette middleware for cross-end trace sync.

Pulls `x-trace-id` and `x-debug-scopes` from incoming requests:
- traceId is stored in a ContextVar and inherited by tracer events.
- scopes are installed as a request-local ContextVar override and restored
  with tokens when the request ends, so concurrent requests stay isolated.
"""

import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from ...runtime.context import (
    SpanContext,
    current_trace_id,
    reset_scope_override,
    reset_span,
    reset_trace_id,
    set_scope_override,
    set_span,
)
from ...runtime.context import (
    set_trace_id as set_context_trace_id,
)
from ...transport.propagators.http import (
    extract_trace_context,
    parse_scopes_header,
)

logger = logging.getLogger(__name__)

def get_trace_id() -> str:
    """Get the trace_id for the current request (or 'no-trace')."""
    return current_trace_id() or "no-trace"


def set_trace_id(trace_id: str) -> None:
    set_context_trace_id(trace_id)


def trace_log(message: str, level: str = "info", **kwargs: Any) -> None:
    """Convenience: log a message with the current request's trace_id."""
    trace_id = get_trace_id()
    log_fn = getattr(logger, level, logger.info)
    if kwargs:
        extra = " ".join(f"{k}={v}" for k, v in kwargs.items())
        log_fn(f"[{trace_id}] {message} | {extra}")
    else:
        log_fn(f"[{trace_id}] {message}")


class TraceMiddleware(BaseHTTPMiddleware):
    """Cross-end trace propagation.

    Headers read from request:
        x-trace-id      — pass-through trace ID; if missing, one is generated
        x-debug-scopes  — JSON string array; an empty array disables all scopes

    Headers written to response:
        x-trace-id      — echoes the resolved trace ID for client debug
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # 1. Resolve trace ID
        propagated = extract_trace_context(request.headers)
        incoming_trace_id = propagated.trace_id
        trace_id = incoming_trace_id
        if not trace_id:
            ts = int(time.time() * 1000)
            short = str(uuid.uuid4())[:8]
            trace_id = f"be-{ts}-{short}"
        trace_token = set_context_trace_id(trace_id)

        span_token = (
            set_span(
                SpanContext(
                    span_id=propagated.parent_span_id,
                    trace_id=trace_id,
                )
            )
            if incoming_trace_id and propagated.parent_span_id
            else None
        )

        # 2. Apply a request-local Scope override from the frontend.
        scope_token = (
            set_scope_override(propagated.scopes)
            if propagated.scopes is not None
            else None
        )

        # 3. Process
        try:
            response = await call_next(request)
            response.headers["x-trace-id"] = trace_id
            return response
        finally:
            if scope_token is not None:
                reset_scope_override(scope_token)
            if span_token is not None:
                reset_span(span_token)
            reset_trace_id(trace_token)

    @staticmethod
    def _parse_scopes(header: str) -> set[str] | None:
        parsed = parse_scopes_header(header)
        return set(parsed) if parsed is not None else None
