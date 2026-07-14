"""TraceLink Python SDK.

Builds protocol-compatible spans, preserves ambient context with ContextVar,
and exports to local files or the shared TraceLink Receiver.

Quick start:
    from tracelink import tracer
    tracer.start_scope('delete-work')
    tracer.entry('router.py:delete', 'Delete work', {'id': 123}, scope='delete-work')
    tracer.end_scope('delete-work')

For FastAPI request context, register the optional framework extension:
    from tracelink import TraceMiddleware
    app.add_middleware(TraceMiddleware)

Built-in layers use FE-* / BE-* names; custom layers use X-*.
"""

from typing import TYPE_CHECKING, Any

from .engine.tracer import TraceExporter, Tracer, tracer
from .engine.types import (
    BUILTIN_LAYERS,
    LogLevel,
    Outcome,
    TraceLayer,
    TraceLog,
    TraceOutcome,
    is_builtin_layer,
    is_custom_layer,
    normalize_layer,
)
from .runtime.context import SpanContext, current_span
from .transport.exporters.http import HttpExporter
from .transport.propagators.http import (
    PropagatedContext,
    create_trace_headers,
    extract_trace_context,
    inject_trace_headers,
)

if TYPE_CHECKING:
    # For static type-checkers only. At runtime TraceMiddleware is resolved
    # lazily via __getattr__ so `import tracelink` works without the optional
    # 'starlette' dependency (the fastapi extra).
    from .extensions.frameworks.fastapi import TraceMiddleware as TraceMiddleware

__version__ = "0.6.2"

__all__ = [
    "Tracer",
    "tracer",
    "TraceExporter",
    "HttpExporter",
    "PropagatedContext",
    "create_trace_headers",
    "extract_trace_context",
    "inject_trace_headers",
    "TraceMiddleware",
    "TraceLayer",
    "TraceLog",
    "LogLevel",
    "Outcome",
    "TraceOutcome",
    "SpanContext",
    "current_span",
    "BUILTIN_LAYERS",
    "is_builtin_layer",
    "is_custom_layer",
    "normalize_layer",
    "__version__",
]


def __getattr__(name: str) -> Any:
    # Lazy, optional-dependency-safe access to the Starlette/FastAPI middleware.
    # Keeps `import tracelink` working with only the stdlib base SDK installed;
    # starlette is pulled in (and a helpful error raised if missing) only when
    # TraceMiddleware is actually accessed.
    if name == "TraceMiddleware":
        try:
            from .extensions.frameworks.fastapi import TraceMiddleware as _TraceMiddleware
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "tracelink.TraceMiddleware requires the optional 'fastapi' extra. "
                "Install it with:  pip install tracelink[fastapi]"
            ) from exc
        return _TraceMiddleware
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
