"""SSE synchronization for the receiver's authoritative Scope policy."""

from __future__ import annotations

import json
import logging
import threading
import urllib.request
from collections.abc import Callable
from typing import Protocol, cast

logger = logging.getLogger(__name__)


class _StreamResponse(Protocol):
    def readline(self, limit: int = -1) -> bytes: ...

    def close(self) -> None: ...


def _stream_endpoint(endpoint: str) -> str:
    normalized = endpoint.rstrip("/")
    return normalized if normalized.endswith("/stream") else f"{normalized}/stream"


class ScopeSync:
    """Consume ``GET /__debug_log/scopes/stream`` on a daemon thread."""

    def __init__(
        self,
        endpoint: str,
        apply_enabled: Callable[[list[str]], None],
        *,
        reconnect_delay_ms: int = 1000,
        timeout_ms: int = 30_000,
    ) -> None:
        self.endpoint = endpoint
        self.apply_enabled = apply_enabled
        self.reconnect_delay = max(reconnect_delay_ms, 10) / 1000.0
        self.timeout = max(timeout_ms, 1) / 1000.0
        self._stop = threading.Event()
        self._state_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._response: _StreamResponse | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run,
            name="tracelink-scope-sync",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        with self._state_lock:
            self._stop.set()
            response = self._response
        if response is not None:
            try:
                response.close()
            except Exception:  # noqa: BLE001 - shutdown is best-effort
                pass

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._consume_once()
            except Exception as exc:  # noqa: BLE001 - control sync is fail-safe
                logger.debug("TraceLink Scope stream disconnected: %s", exc)
            if self._stop.wait(self.reconnect_delay):
                return

    def _consume_once(self) -> None:
        request = urllib.request.Request(
            _stream_endpoint(self.endpoint),
            headers={"Accept": "text/event-stream", "Cache-Control": "no-cache"},
            method="GET",
        )
        response = cast(
            _StreamResponse,
            urllib.request.urlopen(request, timeout=self.timeout),
        )
        with self._state_lock:
            if self._stop.is_set():
                response.close()
                return
            self._response = response

        event_name = ""
        data_lines: list[str] = []
        try:
            while not self._stop.is_set():
                raw_line = response.readline()
                if not raw_line:
                    return
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if not line:
                    self._dispatch(event_name, data_lines)
                    event_name = ""
                    data_lines = []
                elif line.startswith("event:"):
                    event_name = line.removeprefix("event:").strip()
                elif line.startswith("data:"):
                    data_lines.append(line.removeprefix("data:").lstrip())
        finally:
            with self._state_lock:
                if self._response is response:
                    self._response = None
            response.close()

    def _dispatch(self, event_name: str, data_lines: list[str]) -> None:
        if event_name != "scopes" or not data_lines:
            return
        try:
            payload = cast(object, json.loads("\n".join(data_lines)))
            if not isinstance(payload, dict):
                return
            body = cast(dict[str, object], payload)
            enabled = body.get("enabled")
            if not isinstance(enabled, list):
                return
            with self._state_lock:
                if not self._stop.is_set():
                    self.apply_enabled([str(scope) for scope in enabled])
        except Exception as exc:  # noqa: BLE001 - malformed frames are ignored
            logger.debug("TraceLink Scope frame ignored: %s", exc)
