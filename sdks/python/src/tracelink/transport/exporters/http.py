"""HTTP exporter for the standalone TraceLink Receiver.

Python parity with the JavaScript `NodeHttpExporter`: outside
the browser there is no page origin, so the endpoint MUST be an absolute URL
(default ``http://127.0.0.1:5174/__debug_log`` — the receiver ingest path from
``protocol/CONFORMANCE.md`` §2). Each event is serialized as one JSON object
(one NDJSON line on the wire) and POSTed with ``Content-Type: application/json``
plus the correlation headers ``x-trace-id`` / ``x-debug-scopes``.

Hard requirement (CONFORMANCE §2.4): tracing is a dev-time convenience and MUST
NEVER affect the host app. This exporter is:

- **Non-blocking**: ``send()`` just enqueues the log and returns immediately;
  the actual POST happens on a background daemon thread. It never blocks the
  traced code path.
- **Fail-safe**: network / DNS / timeout / non-2xx / CORS errors are swallowed
  silently. An exporter MUST NOT throw into caller code. If the queue is full the log
  is dropped rather than blocking.

Zero third-party dependencies — uses ``urllib.request`` from the stdlib, so the
"``pip install tracelink`` and go" first run stays dependency-free.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.request
from collections.abc import Callable

from ...engine.types import TraceLog
from ..propagators.http import inject_trace_headers

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "http://127.0.0.1:5174/__debug_log"

# Bound the outbound queue so a downed receiver can never grow memory without
# limit; when full we drop (never block the traced code).
_DEFAULT_QUEUE_MAX = 10_000


class HttpExporter:
    """A fire-and-forget HTTP exporter registered with the trace engine.
    or ``tracer.configure(http_endpoint=...)``.

    Example::

        from tracelink import tracer
        from tracelink import HttpExporter

        tracer.add_exporter(HttpExporter())
        # ...emit spans as usual; they POST to the Dashboard in the background...

    The instance is callable, so ``add_exporter(HttpExporter(...))`` works
    without a wrapper.
    """

    def __init__(
        self,
        endpoint: str = DEFAULT_ENDPOINT,
        *,
        timeout_ms: int = 2000,
        disabled: bool = False,
        extra_headers: dict[str, str] | None = None,
        get_enabled_scopes: Callable[[], list[str]] | None = None,
        queue_max: int = _DEFAULT_QUEUE_MAX,
    ) -> None:
        self.endpoint = endpoint
        self.timeout = max(timeout_ms, 1) / 1000.0
        self.disabled = disabled
        self.extra_headers = dict(extra_headers or {})
        self.get_enabled_scopes = get_enabled_scopes or (lambda: ["*"])

        self._queue: queue.Queue[tuple[TraceLog, list[str]] | None] = queue.Queue(
            maxsize=queue_max
        )
        self._worker: threading.Thread | None = None
        self._worker_lock = threading.Lock()
        self._closed = False

        # In-flight accounting so flush() waits for POSTs to *complete*, not
        # merely for the queue to drain (a dequeued item is still mid-POST).
        self._inflight = 0
        self._done_cv = threading.Condition()

    # -- public API ---------------------------------------------------------

    def send(self, log: TraceLog) -> None:
        """Enqueue one log for background POST. Non-blocking; never raises."""
        if self.disabled or self._closed:
            return
        self._ensure_worker()
        # Count the item as in-flight *before* enqueueing so the worker can
        # never decrement below a not-yet-counted item; undo on a full queue.
        with self._done_cv:
            self._inflight += 1
        try:
            # Copy so later mutation of the shared dict can't race the POST.
            snapshot = log.copy()
            self._queue.put_nowait((snapshot, self._safe_scopes()))
        except queue.Full:
            # Receiver is down / slow — drop rather than block the hot path.
            self._mark_done()
            logger.debug("TraceLink HTTP exporter queue full; dropping log")
        except Exception as e:  # noqa: BLE001
            self._mark_done()
            logger.debug(f"TraceLink HTTP exporter enqueue failed: {e}")

    # Callable so add_exporter(HttpExporter(...)) needs no wrapper.
    __call__ = send

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until all enqueued events finish POSTing (or ``timeout``).

        Useful before a short-lived script exits so fire-and-forget events are
        actually delivered. Waits on the in-flight count rather than the queue
        being empty — a dequeued item is still mid-POST — so a ``True`` return
        means every send() so far has completed (success or swallowed error).
        """
        deadline = time.monotonic() + timeout
        with self._done_cv:
            while self._inflight > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._done_cv.wait(remaining)
            return True

    def close(self, timeout: float = 5.0) -> None:
        """Flush, then stop the worker thread. Safe to call more than once."""
        if self._closed:
            return
        self.flush(timeout)
        self._closed = True
        worker = self._worker
        if worker is not None:
            self._queue.put(None)  # poison pill
            worker.join(timeout=timeout)

    # -- internals ----------------------------------------------------------

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        with self._worker_lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._run,
                name="tracelink-http-exporter",
                daemon=True,
            )
            self._worker.start()

    def _mark_done(self) -> None:
        """Decrement the in-flight count and wake any flush() waiters."""
        with self._done_cv:
            if self._inflight > 0:
                self._inflight -= 1
            self._done_cv.notify_all()

    def _run(self) -> None:
        while True:
            try:
                item = self._queue.get()
            except Exception:  # noqa: BLE001
                continue
            if item is None:  # poison pill from close()
                self._queue.task_done()
                return
            try:
                log, scopes = item
                self._post(log, scopes)
            except Exception as e:  # noqa: BLE001 — swallow ALL transport errors
                logger.debug(f"TraceLink HTTP exporter POST failed: {e}")
            finally:
                self._queue.task_done()
                self._mark_done()

    def _post(self, log: TraceLog, scopes: list[str]) -> None:
        body = json.dumps(log, ensure_ascii=False).encode("utf-8")
        headers = inject_trace_headers(
            {"Content-Type": "application/json", **self.extra_headers},
            trace_id=str(log.get("traceId", "")),
            parent_span_id=str(log.get("spanId", "")),
            scopes=scopes,
        )
        req = urllib.request.Request(
            self.endpoint, data=body, headers=headers, method="POST"
        )
        # Response body is irrelevant (receiver replies 204); just drain+close.
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            resp.read()

    def _safe_scopes(self) -> list[str]:
        try:
            scopes = self.get_enabled_scopes()
            return [str(s) for s in scopes]
        except Exception:  # noqa: BLE001
            return ["*"]
