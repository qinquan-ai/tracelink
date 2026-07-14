"""Exporter fan-out and HTTP exporter tests.

Covers the parity work with the JS tracer:
  - `add_exporter` fan-out, unsubscribe, and fail-safe isolation;
  - the `HttpExporter` transport: POSTs each `TraceLog` as JSON to `/__debug_log`
    with `x-trace-id` / `x-debug-scopes` headers, carrying the full TraceLog fields
    (`level` / `outcome` / `durationMs` / `async` / `data.reason`).
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tracelink.transport.exporters.http import HttpExporter
from tracelink.transport.exporters.paths import ndjson_path


@pytest.fixture
def isolated_tracer(tmp_path, monkeypatch):
    """Redirect log paths to a temp dir and reset the live singleton state,
    including the exporter registry and HTTP slot."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACELINK_DIR", str(tmp_path))
    monkeypatch.setenv("TRACELINK_ENABLED", "true")
    import importlib
    tracer_mod = importlib.import_module("tracelink.engine.tracer")

    inst = tracer_mod.tracer
    inst._enabled = True
    inst._enabled_scopes = {"*"}
    inst._logs = []
    inst._active_traces = {}
    inst._trace_id = None
    inst._span_counter = 0
    inst._exporters = []
    inst._http_exporter = None
    inst._file_enabled = True
    yield inst
    if inst._http_exporter is not None and hasattr(inst._http_exporter, "close"):
        inst._http_exporter.close(timeout=1.0)
    inst._http_exporter = None
    inst._exporters = []
    inst._file_enabled = True
    inst._logs = []
    inst._active_traces = {}
    inst._enabled_scopes = {"*"}


# ---------------------------------------------------------------------------
# add_exporter fan-out
# ---------------------------------------------------------------------------


def test_add_exporter_receives_built_log(isolated_tracer):
    received = []
    isolated_tracer.add_exporter(received.append)

    isolated_tracer.entry("router.py:x", "hi", {"a": 1}, level="info", scope="s")

    assert len(received) == 1
    log = received[0]
    assert log["layer"] == "BE-ENTRY"
    assert log["msg"] == "hi"
    assert log["level"] == "info"
    assert log["data"]["a"] == 1
    # Same dict that hit the memory buffer (built once, fanned out).
    assert isolated_tracer.get_logs()[-1] is log


def test_add_exporter_unsubscribe_stops_delivery(isolated_tracer):
    received = []
    off = isolated_tracer.add_exporter(received.append)

    isolated_tracer.entry("x", "one", scope="s")
    off()
    isolated_tracer.entry("x", "two", scope="s")

    assert [log["msg"] for log in received] == ["one"]


def test_exporter_raising_does_not_break_tracing(isolated_tracer):
    calls = {"good": 0}

    def boom(_log):
        raise RuntimeError("exporter blew up")

    def good(_log):
        calls["good"] += 1

    isolated_tracer.add_exporter(boom)
    isolated_tracer.add_exporter(good)

    # Must not raise into user code, and the healthy exporter still runs.
    isolated_tracer.entry("x", "resilient", scope="s")

    assert calls["good"] == 1
    assert isolated_tracer.get_logs()[-1]["msg"] == "resilient"


def test_fan_out_covers_http_slot_and_custom_exporters(isolated_tracer):
    http_seen = []
    custom_seen = []
    isolated_tracer.configure(http_exporter=http_seen.append)
    isolated_tracer.add_exporter(custom_seen.append)

    isolated_tracer.entry("x", "both", scope="s")

    assert len(http_seen) == 1
    assert len(custom_seen) == 1
    assert http_seen[0]["msg"] == "both"


def test_default_file_exporter_can_be_disabled(isolated_tracer):
    isolated_tracer.configure(file_enabled=False)
    isolated_tracer.entry("x", "receiver owns persistence", scope="s")

    assert not ndjson_path().exists()


# ---------------------------------------------------------------------------
# HttpExporter transport
# ---------------------------------------------------------------------------


class _CaptureHandler(BaseHTTPRequestHandler):
    received = []  # class-level; reset per server in the fixture

    def do_POST(self):  # noqa: N802 - http.server naming
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        type(self).received.append(
            {
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            }
        )
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):  # silence the default stderr spam
        pass


@pytest.fixture
def capture_server():
    _CaptureHandler.received = []
    server = HTTPServer(("127.0.0.1", 0), _CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield f"http://{host}:{port}/__debug_log", _CaptureHandler.received
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_http_exporter_posts_all_fields(isolated_tracer, capture_server):
    endpoint, received = capture_server

    exporter = isolated_tracer.configure(http_endpoint=endpoint)

    # A blocked outcome (outcome + level=warn + data.reason).
    isolated_tracer.blocked(
        "routes/work:delete", "DELETE rejected",
        reason="insufficient permission", data={"workId": "w_1"}, scope="s",
    )
    # An error-level normal log (level variety).
    isolated_tracer.entry("router.py:boom", "non-fatal", level="error", scope="s")
    # A span → open + close; close carries durationMs + async.
    isolated_tracer.span("BE-ENTRY", "router.py:h", "handle", lambda: None, scope="s")

    # Wait for the background daemon thread to drain.
    assert exporter.flush(timeout=3) is True

    # 1 blocked + 1 entry + 2 span events (open, close) = 4 POSTs.
    assert len(received) == 4

    for req in received:
        assert req["path"] == "/__debug_log"
        assert req["headers"]["content-type"] == "application/json"
        assert "x-trace-id" in req["headers"]
        assert "x-parent-span-id" in req["headers"]
        assert json.loads(req["headers"]["x-debug-scopes"]) == ["*"]

    bodies = [json.loads(r["body"]) for r in received]
    by_msg = {b["msg"]: b for b in bodies}

    blocked_log = by_msg["DELETE rejected"]
    assert blocked_log["outcome"] == "blocked"
    assert blocked_log["level"] == "warn"
    assert blocked_log["data"]["reason"] == "insufficient permission"

    assert by_msg["non-fatal"]["level"] == "error"

    # The span-close body carries durationMs + async (reserved key serialized).
    close_logs = [b for b in bodies if "durationMs" in b]
    assert len(close_logs) == 1
    assert isinstance(close_logs[0]["durationMs"], int)
    assert close_logs[0]["async"] is False


def test_http_exporter_send_is_failsafe_when_receiver_down(isolated_tracer):
    # Point at a closed port; send() must not block or raise, tracing continues.
    exporter = HttpExporter(endpoint="http://127.0.0.1:59999/__debug_log", timeout_ms=200)
    isolated_tracer.add_exporter(exporter)

    isolated_tracer.entry("x", "no receiver", scope="s")  # must not raise
    exporter.flush(timeout=1)  # background delivery fails silently

    assert isolated_tracer.get_logs()[-1]["msg"] == "no receiver"
    exporter.close(timeout=1)


def test_http_exporter_disabled_is_noop(isolated_tracer):
    exporter = HttpExporter(endpoint="http://127.0.0.1:59999/__debug_log", disabled=True)
    # No worker thread should be spawned while disabled.
    exporter.send({"traceId": "t", "msg": "x"})
    assert exporter._worker is None
