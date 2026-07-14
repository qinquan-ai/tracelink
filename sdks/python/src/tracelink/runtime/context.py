"""Ambient span context for TraceLink Python.

Mirrors the JavaScript Engine/Node Runtime context contract: an
enclosing span is discoverable so nested tracer calls inherit `parentSpanId`
without threading it by hand. Per `protocol/CONFORMANCE.md`, the ambient
span MUST be backed by `contextvars.ContextVar` (not thread-locals), so linkage
stays correct across nested calls, `await`, and concurrent asyncio tasks. A new
OS thread requires explicit context propagation.
"""

from collections.abc import Iterable
from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass(frozen=True)
class SpanContext:
    """The context of the enclosing span, if any."""

    span_id: str
    trace_id: str
    scope: str | None = None
    recording: bool = True


_current_span: ContextVar[SpanContext | None] = ContextVar(
    "tracelink_current_span", default=None
)
_request_trace_id: ContextVar[str | None] = ContextVar(
    "tracelink_request_trace_id", default=None
)
_scope_override: ContextVar[frozenset[str] | None] = ContextVar(
    "tracelink_scope_override", default=None
)


def current_span() -> SpanContext | None:
    """The context of the enclosing span, or None at the top level."""
    return _current_span.get()


def set_span(ctx: SpanContext) -> Token[SpanContext | None]:
    """Install `ctx` as the active span; returns a token for reset()."""
    return _current_span.set(ctx)


def reset_span(token: Token[SpanContext | None]) -> None:
    """Restore the span context that was active before the matching set_span()."""
    _current_span.reset(token)


def current_trace_id() -> str | None:
    """Return the trace ID propagated by the current request, if any."""
    return _request_trace_id.get()


def set_trace_id(trace_id: str) -> Token[str | None]:
    """Install a request trace ID and return a token for exact restoration."""
    return _request_trace_id.set(trace_id)


def reset_trace_id(token: Token[str | None]) -> None:
    """Restore the request trace ID active before ``set_trace_id``."""
    _request_trace_id.reset(token)


def current_scope_override() -> frozenset[str] | None:
    """Return the request-local Scope filter, including an explicit empty set."""
    return _scope_override.get()


def set_scope_override(scopes: Iterable[str]) -> Token[frozenset[str] | None]:
    """Install a request-local Scope filter and return a restoration token."""
    return _scope_override.set(frozenset(scopes))


def reset_scope_override(token: Token[frozenset[str] | None]) -> None:
    """Restore the Scope filter active before ``set_scope_override``."""
    _scope_override.reset(token)
