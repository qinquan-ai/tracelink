"""Python trace engine singleton.

Builds schema-compatible TraceLog events, writes local NDJSON/readable files,
and fans events out to optional exporters. Built-in layers use the FE-* / BE-*
namespaces; custom layers use X-*.
"""

import inspect
import logging
import os
import sys
import threading
from collections.abc import Awaitable, Callable
from typing import Any, Optional, TypeVar

from ..runtime.context import (
    SpanContext,
    current_scope_override,
    current_span,
    current_trace_id,
    reset_span,
    set_span,
)
from ..transport.control.scope_sync import ScopeSync
from ..transport.exporters.file import FileExporter
from .sanitize import sanitize_data
from .time import format_ts, make_span_id, make_trace_id, now_ms
from .types import (
    BUILTIN_LAYERS,
    LayerMeta,
    LogLevel,
    Outcome,
    ScopeInfo,
    TraceLog,
    is_builtin_layer,
    normalize_layer,
)

T = TypeVar("T")

# An exporter receives one built TraceLog. Exporters must be fail-safe: an
# exporter exception is swallowed so tracing cannot break application code.
TraceExporter = Callable[[TraceLog], None]

logger = logging.getLogger(__name__)


_BUILTIN_DESCRIPTIONS = {
    "FE-ACTION": "User clicks, form submits",
    "FE-API": "Outgoing HTTP request",
    "FE-WS": "WebSocket message",
    "FE-UI": "DOM/scroll/viewport check",
    "BE-ENTRY": "API endpoint entry",
    "BE-INTERNAL": "Internal helper",
    "BE-DB": "Database op",
    "BE-WS": "WebSocket push",
}


class Tracer:
    """Singleton tracer.

    Use `from tracelink import tracer` — don't instantiate this directly.
    """

    _instance: Optional["Tracer"] = None
    _initialized: bool

    def __new__(cls) -> "Tracer":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True

        # Master switch
        self._enabled = self._resolve_enabled()

        # Session bookkeeping
        self._span_counter = 0
        self._logs: list[TraceLog] = []
        self._active_traces: dict[str, ScopeInfo] = {}

        # Scope filter
        self._scope_lock = threading.RLock()
        self._enabled_scopes: set[str] = self._resolve_enabled_scopes()
        self._scope_sync: ScopeSync | None = None

        # Layer registry (X-* custom layers)
        self._layer_registry: dict[str, LayerMeta] = {}

        # A dedicated HTTP slot can be replaced by configure(); additional
        # exporters are registered through add_exporter().
        self._http_exporter: TraceExporter | None = None
        self._exporters: list[TraceExporter] = []
        self._file_exporter = FileExporter()
        self._file_enabled = True

    # =========================================================================
    # Master switch
    # =========================================================================

    def _resolve_enabled(self) -> bool:
        env = os.getenv("TRACELINK_ENABLED", "").lower()
        if env in ("false", "0", "no"):
            return False
        if env in ("true", "1", "yes"):
            return True
        # Default: enabled if dev/debug mode env is set
        return bool(os.getenv("DEBUG") or os.getenv("DEV"))

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    def is_enabled(self) -> bool:
        return self._enabled

    # =========================================================================
    # Configure + exporter fan-out
    # =========================================================================

    def configure(
        self,
        *,
        enabled: bool | None = None,
        http_endpoint: str | None = None,
        http_exporter: TraceExporter | None = None,
        http_timeout_ms: int = 2000,
        http_extra_headers: dict[str, str] | None = None,
        http_disabled: bool = False,
        file_enabled: bool | None = None,
        scope_sync_endpoint: str | None = None,
        scope_sync_reconnect_ms: int = 1000,
        scope_sync_timeout_ms: int = 30_000,
    ) -> TraceExporter | None:
        """Configure the engine and optional HTTP exporter.

        Point the Python SDK at a standalone Receiver + Dashboard:

            from tracelink import tracer
            tracer.configure(http_endpoint="http://127.0.0.1:5174/__debug_log")

        Passing `http_endpoint` builds a non-blocking, fail-safe HttpExporter
        and installs it in the reconfigurable HTTP slot. For full control, pass
        `http_exporter=...` or call `add_exporter()`.

        Returns the installed HTTP exporter so short-lived callers can flush it.

        Passing `scope_sync_endpoint` starts a daemon SSE client that applies
        the Receiver's authoritative enabled Scope list locally. Call
        `stop_scope_sync()` to stop it.
        """
        if enabled is not None:
            self._enabled = enabled
        if file_enabled is not None:
            self._file_enabled = file_enabled
        if http_exporter is not None:
            self._http_exporter = http_exporter
        elif http_endpoint is not None:
            # Lazy import keeps the Engine import cheap for users who never
            # touch the HTTP transport.
            from ..transport.exporters.http import HttpExporter

            self._http_exporter = HttpExporter(
                endpoint=http_endpoint,
                timeout_ms=http_timeout_ms,
                disabled=http_disabled,
                extra_headers=http_extra_headers or {},
                get_enabled_scopes=self.get_enabled_scopes,
            )
        if scope_sync_endpoint is not None:
            self.start_scope_sync(
                scope_sync_endpoint,
                reconnect_delay_ms=scope_sync_reconnect_ms,
                timeout_ms=scope_sync_timeout_ms,
            )
        return self._http_exporter

    def add_exporter(self, exporter: TraceExporter) -> Callable[[], None]:
        """Register a custom exporter; returns an unsubscribe callable.

        Every emitted TraceLog is fanned out to all registered exporters. An
        exporter exception is isolated from the traced application.

            from tracelink import tracer
            from tracelink import HttpExporter

            off = tracer.add_exporter(HttpExporter())
            # ... later ...
            off()  # stop exporting
        """
        self._exporters.append(exporter)

        def unsubscribe() -> None:
            try:
                self._exporters.remove(exporter)
            except ValueError:
                pass

        return unsubscribe

    def _fan_out(self, log: TraceLog) -> None:
        """Fan a built log out to the configured exporters.

        Each exporter is isolated in its own try/except: failures must
        NOT break tracing or the traced user code (CONFORMANCE §2.4).
        """
        if self._http_exporter is not None:
            try:
                self._http_exporter(log)
            except Exception as e:  # noqa: BLE001
                logger.debug(f"TraceLink HTTP exporter failed: {e}")
        for exporter in list(self._exporters):
            try:
                exporter(log)
            except Exception as e:  # noqa: BLE001
                logger.debug(f"TraceLink exporter failed: {e}")

    # =========================================================================
    # Scope filter
    # =========================================================================

    def _resolve_enabled_scopes(self) -> set[str]:
        scopes_str = os.getenv("TRACELINK_SCOPES", "*")
        if scopes_str == "*":
            return {"*"}
        return {s.strip() for s in scopes_str.split(",") if s.strip()}

    def enable_scope(self, scope: str) -> None:
        with self._scope_lock:
            self._enabled_scopes.discard("*")
            self._enabled_scopes.add(scope)

    def disable_scope(self, scope: str) -> None:
        with self._scope_lock:
            self._enabled_scopes.discard(scope)

    def enable_all_scopes(self) -> None:
        self.set_enabled_scopes(["*"])

    def disable_all_scopes(self) -> None:
        self.set_enabled_scopes([])

    def set_enabled_scopes(self, scopes: list[str]) -> None:
        with self._scope_lock:
            self._enabled_scopes = set(scopes)

    def get_enabled_scopes(self) -> list[str]:
        override = current_scope_override()
        if override is not None:
            return sorted(override)
        with self._scope_lock:
            return sorted(self._enabled_scopes)

    def _is_scope_enabled(self, scope: str | None) -> bool:
        if not self._enabled:
            return False
        override = current_scope_override()
        if override is not None:
            enabled_scopes = override
        else:
            with self._scope_lock:
                enabled_scopes = frozenset(self._enabled_scopes)
        if "*" in enabled_scopes:
            return True
        if not scope:
            return False
        return scope in enabled_scopes

    def start_scope_sync(
        self,
        endpoint: str,
        *,
        reconnect_delay_ms: int = 1000,
        timeout_ms: int = 30_000,
    ) -> None:
        self.stop_scope_sync()
        sync = ScopeSync(
            endpoint,
            self.set_enabled_scopes,
            reconnect_delay_ms=reconnect_delay_ms,
            timeout_ms=timeout_ms,
        )
        self._scope_sync = sync
        sync.start()

    def stop_scope_sync(self) -> None:
        sync = self._scope_sync
        self._scope_sync = None
        if sync is not None:
            sync.stop()

    # =========================================================================
    # Session mode (start_scope / end_scope)
    # =========================================================================

    def start_scope(self, scope: str, custom_id: str | None = None) -> str:
        """Begin a scoped session. Returns the trace_id."""
        trace_id = custom_id or make_trace_id(scope)
        recording = self._is_scope_enabled(scope)
        self._active_traces[scope] = {
            "id": trace_id,
            "start_time": now_ms() / 1000,
            "recording": recording,
        }
        if recording:
            self._emit(
                "BE-ENTRY",
                "Tracer:start_scope",
                f"开始追踪: {scope}",
                {"scope": scope, "traceId": trace_id},
                scope=scope,
                _bypass_capture_gate=True,
            )
        return trace_id

    def end_scope(self, scope: str) -> int | None:
        """End a scoped session. Returns duration_ms."""
        info = self._active_traces.pop(scope, None)
        if not info:
            return None
        duration = int((now_ms() / 1000 - info["start_time"]) * 1000)
        if info["recording"]:
            self._emit(
                "BE-ENTRY",
                "Tracer:end_scope",
                f"结束追踪: {scope}",
                {"scope": scope, "duration": duration},
                scope=scope,
                _trace_id=info["id"],
                _bypass_capture_gate=True,
            )
        return duration

    def get_trace_id(self, scope: str) -> str | None:
        info = self._active_traces.get(scope)
        return info["id"] if info else None

    def get_active_scopes(self) -> list[str]:
        return list(self._active_traces.keys())

    # =========================================================================
    # Layer registry — for custom (X-*) layers
    # =========================================================================

    def register_layer(self, name: str, meta: LayerMeta) -> None:
        """Register a custom layer. Optional but recommended for AI agent readability.

        Example:
            tracer.register_layer("X-AI-INFERENCE", {
                "description": "LLM call to OpenAI",
                "color": "#aa88ff",
            })

        Built-in layers (FE-*/BE-*) reject registration overrides.
        """
        normalized = normalize_layer(name)
        if is_builtin_layer(normalized):
            return
        self._layer_registry[normalized] = meta

    def get_registered_layers(self) -> dict[str, LayerMeta]:
        """All built-in + registered custom layers."""
        result: dict[str, LayerMeta] = {
            layer: {"description": _BUILTIN_DESCRIPTIONS[layer]}
            for layer in BUILTIN_LAYERS
        }
        for name, meta in self._layer_registry.items():
            result[name] = meta
        return result

    # =========================================================================
    # Stream mode (use scope name as traceId directly)
    # =========================================================================

    def _resolve_trace_id(self, scope: str | None) -> str:
        if scope:
            existing = self.get_trace_id(scope)
            if existing:
                return existing
        request_trace_id = current_trace_id()
        if request_trace_id:
            return request_trace_id
        if scope:
            return make_trace_id(scope)
        return "no-trace"

    # =========================================================================
    # Public log entry points (one per built-in layer)
    # =========================================================================

    def entry(
        self,
        fn: str,
        msg: str,
        data: dict[str, Any] | None = None,
        *,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self._emit("BE-ENTRY", fn, msg, data, level=level, scope=scope, user_id=user_id)

    def internal(
        self,
        fn: str,
        msg: str,
        data: dict[str, Any] | None = None,
        *,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        self._emit(
            "BE-INTERNAL", fn, msg, data,
            level=level, scope=scope, user_id=user_id, parent_span_id=parent_span_id,
        )

    def db(
        self,
        fn: str,
        msg: str,
        data: dict[str, Any] | None = None,
        *,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        self._emit(
            "BE-DB", fn, msg, data,
            level=level, scope=scope, user_id=user_id, parent_span_id=parent_span_id,
        )

    def ws(
        self,
        fn: str,
        msg: str,
        data: dict[str, Any] | None = None,
        *,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        self._emit(
            "BE-WS", fn, msg, data,
            level=level, scope=scope, user_id=user_id, parent_span_id=parent_span_id,
        )

    def custom(
        self,
        layer: str,
        fn: str,
        msg: str,
        data: dict[str, Any] | None = None,
        *,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        """Emit an event under a custom (X-*) layer.

        Layer name is normalized — passing 'RENDER' will emit as 'X-RENDER'.
        Register the layer via `register_layer()` for richer summary metadata.
        """
        normalized = normalize_layer(layer)
        self._emit(
            normalized, fn, msg, data,
            level=level, scope=scope, user_id=user_id, parent_span_id=parent_span_id,
        )

    # =========================================================================
    # Interaction outcome helpers (blocked / intent) — parity with JS tracer
    # =========================================================================

    def blocked(
        self,
        fn: str,
        msg: str,
        *,
        reason: str | None = None,
        data: dict[str, Any] | None = None,
        layer: str = "BE-INTERNAL",
        level: LogLevel = "warn",
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        """Emit a `blocked` outcome — an intercepted / rejected / not-really-
        executed call. Defaults to `level='warn'` and `layer='BE-INTERNAL'`
        (both overridable). The reason goes into `data['reason']` (there is no
        top-level reason field).
        """
        self._emit_outcome(
            "blocked", level, layer, fn, msg,
            reason=reason, data=data, scope=scope,
            user_id=user_id, parent_span_id=parent_span_id,
        )

    def intent(
        self,
        fn: str,
        msg: str,
        *,
        reason: str | None = None,
        data: dict[str, Any] | None = None,
        layer: str = "BE-INTERNAL",
        level: LogLevel = "info",
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> None:
        """Emit an `intent` outcome — an intent or no-op (wanted to, but
        didn't). Defaults to `level='info'` and `layer='BE-INTERNAL'`. The
        reason goes into `data['reason']`.
        """
        self._emit_outcome(
            "intent", level, layer, fn, msg,
            reason=reason, data=data, scope=scope,
            user_id=user_id, parent_span_id=parent_span_id,
        )

    def _emit_outcome(
        self,
        outcome: Outcome,
        level: LogLevel,
        layer: str,
        fn: str,
        msg: str,
        *,
        reason: str | None,
        data: dict[str, Any] | None,
        scope: str | None,
        user_id: str | None,
        parent_span_id: str | None,
    ) -> None:
        merged: dict[str, Any] = dict(data or {})
        if reason is not None:
            merged["reason"] = reason
        self._emit(
            normalize_layer(layer), fn, msg, merged,
            level=level, outcome=outcome, scope=scope,
            user_id=user_id, parent_span_id=parent_span_id,
        )

    # =========================================================================
    # Span — auto parent/child nesting + duration + async (contextvars-backed)
    # =========================================================================

    def span(
        self,
        layer: str,
        fn: str,
        msg: str,
        func: Callable[[], T | Awaitable[T]],
        *,
        data: dict[str, Any] | None = None,
        level: LogLevel | None = None,
        scope: str | None = None,
        user_id: str | None = None,
    ) -> T | Awaitable[T]:
        """Open a span around `func`, mirroring the JS `tracer.span()` contract.

        A fresh `spanId` is generated and a "span-open" event is emitted so the
        span is visible immediately. `func` then runs with that span installed
        as the ambient context (via contextvars), so any tracer call inside it
        inherits `parentSpanId = <this span's spanId>` and shares the enclosing
        `traceId`. When `func` finishes, a "span-close" event carrying
        `durationMs` (real elapsed ms) and `async` (whether `func()` returned an
        awaitable) is emitted, correlated by the SAME `spanId`/`traceId`.

        Works for sync and async `func`: if `func()` returns an awaitable, this
        returns a coroutine that awaits it, measures the real elapsed time, then
        emits the close event — so `await tracer.span(...)` yields `func`'s
        result. Open and close share one span ID by protocol design.
        """
        normalized_layer = normalize_layer(layer)
        parent = current_span()
        self._span_counter += 1
        span_id = make_span_id(self._span_counter)
        resolved_scope = scope if scope is not None else (parent.scope if parent else None)
        parent_span_id = parent.span_id if parent and parent.recording else None
        recording = not (
            parent is not None and not parent.recording and scope is None
        ) and self._is_scope_enabled(resolved_scope)

        if scope:
            trace_id = self._resolve_trace_id(scope)
        elif parent:
            trace_id = parent.trace_id
        else:
            trace_id = self._resolve_trace_id(None)

        if recording:
            self._emit(
                normalized_layer, fn, msg, data,
                level=level, scope=resolved_scope, user_id=user_id,
                parent_span_id=parent_span_id, _span_id=span_id, _trace_id=trace_id,
                _bypass_capture_gate=True,
            )

        ctx = SpanContext(
            span_id=span_id,
            trace_id=trace_id,
            scope=resolved_scope,
            recording=recording,
        )
        start = now_ms()

        def emit_close(is_async: bool) -> None:
            if not recording:
                return
            self._emit(
                normalized_layer, fn, msg, data,
                level=level, scope=resolved_scope, user_id=user_id,
                parent_span_id=parent_span_id, _span_id=span_id, _trace_id=trace_id,
                _duration_ms=now_ms() - start,
                _async=is_async,
                _bypass_capture_gate=True,
            )

        token = set_span(ctx)
        try:
            result = func()
        except BaseException:
            reset_span(token)
            emit_close(False)
            raise

        if inspect.isawaitable(result):
            # Coroutine body hasn't run yet — re-establish the context inside the
            # runner so nested awaits inherit it, then emit close after settle.
            reset_span(token)

            async def _runner() -> T:
                inner_token = set_span(ctx)
                try:
                    return await result
                finally:
                    reset_span(inner_token)
                    emit_close(True)

            return _runner()

        reset_span(token)
        emit_close(False)
        return result

    # =========================================================================
    # Internal — build log + write
    # =========================================================================

    def _emit(
        self,
        layer: str,
        fn: str,
        msg: str,
        data: dict[str, Any] | None,
        *,
        level: LogLevel | None = None,
        outcome: Outcome | None = None,
        scope: str | None = None,
        user_id: str | None = None,
        parent_span_id: str | None = None,
        # Internal overrides used by span() to correlate open/close events.
        _span_id: str | None = None,
        _trace_id: str | None = None,
        _duration_ms: int | None = None,
        _async: bool | None = None,
        _bypass_capture_gate: bool = False,
    ) -> None:
        # Auto span context: an enclosing span (if any) supplies the default
        # parent span, scope, and trace to inherit. Explicit fields still win.
        ctx = current_span()
        resolved_scope = scope if scope is not None else (ctx.scope if ctx else None)

        if (
            not _bypass_capture_gate
            and ctx is not None
            and not ctx.recording
            and scope is None
        ):
            return
        if not _bypass_capture_gate and not self._is_scope_enabled(resolved_scope):
            return

        timestamp = now_ms()

        if _trace_id is not None:
            trace_id = _trace_id
        elif scope:
            trace_id = self._resolve_trace_id(scope)
        elif ctx:
            trace_id = ctx.trace_id
        else:
            trace_id = self._resolve_trace_id(None)

        if _span_id is not None:
            span_id = _span_id
        else:
            self._span_counter += 1
            span_id = make_span_id(self._span_counter)

        resolved_parent = (
            parent_span_id if parent_span_id is not None
            else (ctx.span_id if ctx and ctx.recording else None)
        )

        sanitized = sanitize_data(data)
        normalized_layer = normalize_layer(layer)

        log: TraceLog = {
            "ts": format_ts(timestamp),
            "layer": normalized_layer,
            "fn": fn,
            "msg": msg,
            "data": sanitized,
            "traceId": trace_id,
            "spanId": span_id,
        }
        if level is not None:
            log["level"] = level
        if outcome is not None:
            log["outcome"] = outcome
        if resolved_scope:
            log["scope"] = resolved_scope
        if user_id:
            log["userId"] = user_id
        if resolved_parent:
            log["parentSpanId"] = resolved_parent
        if _duration_ms is not None:
            log["durationMs"] = _duration_ms
        if _async is not None:
            log["async"] = _async

        # Build-once, fan-out: the TraceLog above is built a single time and
        # then dispatched to the built-in memory, console, and file exporters,
        # followed by every configured custom exporter.

        # Memory
        self._logs.append(log)

        # Print (always-on, helps in dev)
        self._print(log)

        # Optional local exporter. Disable it when a Receiver in the same
        # project owns the authoritative files to avoid duplicate rows.
        if self._file_enabled:
            self._file_exporter(log)

        # Opt-in exporters are fail-safe and never break user code.
        self._fan_out(log)

    def _print(self, log: TraceLog) -> None:
        try:
            print(f"[{log['ts']}][{log['layer']}][{log['fn']}] {log['msg']}", file=sys.stderr)
            if log.get("data"):
                data_str = str(log["data"])
                if len(data_str) > 500:
                    data_str = data_str[:500] + "..."
                print(f"  {data_str}", file=sys.stderr)
        except UnicodeEncodeError:
            # Windows GBK fallback
            pass

    # =========================================================================
    # Memory access (for tests / in-process inspection)
    # =========================================================================

    def get_logs(self) -> list[TraceLog]:
        return list(self._logs)

    def clear(self) -> None:
        self._logs = []
        self._span_counter = 0

    def reset_files(self) -> None:
        self._file_exporter.reset()


# Module-level singleton
tracer = Tracer()
