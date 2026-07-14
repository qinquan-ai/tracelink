"""Python tracer tests."""

import json
import time

import pytest

from tracelink.engine.sanitize import sanitize_data
from tracelink.engine.time import format_ts, make_trace_id


def test_sanitize_truncates_long_string():
    long_str = "x" * 500
    out = sanitize_data({"long": long_str})
    assert out["long"].endswith("[500 chars]")
    assert len(out["long"]) < 500


def test_sanitize_truncates_base64():
    out = sanitize_data({"img": "data:image/png;base64," + "A" * 200})
    assert out["img"].endswith("...[truncated]")


def test_sanitize_handles_nested():
    out = sanitize_data({"nested": {"deep": {"deeper": {"x": "y"}}}})
    assert out["nested"]["deep"]["deeper"]["x"] == "y"


def test_make_trace_id_format():
    tid = make_trace_id("delete-work")
    parts = tid.split("-")
    # delete-work -> "delete", "work" -> "-".join(parts[:2]) = "delete-work"
    assert tid.startswith("delete-work-")
    assert len(parts[-1]) == 3  # random suffix


def test_format_ts_bracket_format():
    ts = format_ts(1700000000000)
    assert ts.startswith("[")
    assert ts.endswith("]")


@pytest.fixture
def isolated_tracer(tmp_path, monkeypatch):
    """Redirect log paths to a temp dir and reset the singleton's state.

    NOTE: `from tracelink import tracer` binds the module-level singleton
    at first import, so merely clearing `Tracer._instance` does not rebind
    the exported name. We reset the mutable runtime state on the live singleton
    (and force-enable + wildcard scope) so each test starts from a known state.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRACELINK_DIR", str(tmp_path))
    monkeypatch.setenv("TRACELINK_ENABLED", "true")
    import importlib
    tracer_mod = importlib.import_module("tracelink.engine.tracer")
    inst = tracer_mod.tracer
    inst.stop_scope_sync()
    inst._enabled = True
    inst._enabled_scopes = {"*"}
    inst._logs = []
    inst._active_traces = {}
    inst._trace_id = None
    inst._span_counter = 0
    inst._exporters = []
    inst._http_exporter = None
    yield tmp_path
    inst.stop_scope_sync()
    inst._logs = []
    inst._active_traces = {}
    inst._enabled_scopes = {"*"}
    inst._exporters = []
    inst._http_exporter = None


def test_tracer_writes_ndjson(isolated_tracer):
    from tracelink import tracer

    tracer.entry("router.py:delete", "delete work", {"id": 42}, scope="delete-work")

    ndjson = isolated_tracer / ".tracelink" / "trace.ndjson"
    assert ndjson.exists()
    lines = ndjson.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["layer"] == "BE-ENTRY"
    assert record["scope"] == "delete-work"
    assert record["msg"] == "delete work"


def test_tracer_writes_readable(isolated_tracer):
    from tracelink import tracer

    tracer.entry("router.py:delete", "delete work", {"id": 42}, scope="delete-work")

    readable = isolated_tracer / ".tracelink" / "trace.log"
    assert readable.exists()
    text = readable.read_text(encoding="utf-8")
    assert "[BE-ENTRY]" in text
    assert "delete work" in text


def test_scope_filter_silences_disabled(isolated_tracer):
    from tracelink import tracer

    tracer.disable_all_scopes()
    tracer.enable_scope("cancel-task")

    tracer.entry("x", "filtered", scope="delete-work")
    tracer.entry("x", "kept", scope="cancel-task")

    logs = tracer.get_logs()
    assert len(logs) == 1
    assert logs[0]["scope"] == "cancel-task"


def test_scope_sync_applies_receiver_config(isolated_tracer, monkeypatch):
    from tracelink import tracer

    calls = 0

    class FakeResponse:
        def __init__(self):
            self.lines = iter(
                [
                    b"event: scopes\n",
                    b'data: {"enabled":["delete-work"]}\n',
                    b"\n",
                ]
            )

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def readline(self, _limit=-1):
            return next(self.lines, b"")

        def close(self):
            return None

    def fake_urlopen(request, *, timeout):
        nonlocal calls
        calls += 1
        assert request.full_url.endswith("/__debug_log/scopes/stream")
        assert timeout == pytest.approx(30.0)
        return FakeResponse()

    monkeypatch.setattr(
        "tracelink.transport.control.scope_sync.urllib.request.urlopen",
        fake_urlopen,
    )
    tracer.configure(
        scope_sync_endpoint="http://127.0.0.1:5174/__debug_log/scopes",
        scope_sync_reconnect_ms=20,
    )

    deadline = time.monotonic() + 1
    while tracer.get_enabled_scopes() != ["delete-work"]:
        assert time.monotonic() < deadline
        time.sleep(0.01)

    tracer.entry("x", "filtered", scope="other")
    tracer.entry("x", "kept", scope="delete-work")
    assert [log["msg"] for log in tracer.get_logs()] == ["kept"]

    tracer.stop_scope_sync()
    call_count = calls
    time.sleep(0.06)
    assert calls == call_count


def test_session_mode_tracks_duration(isolated_tracer):
    import time

    from tracelink import tracer

    tracer.start_scope("delete-work")
    tracer.entry("x", "work", scope="delete-work")
    time.sleep(0.05)
    duration = tracer.end_scope("delete-work")
    assert duration is not None
    assert duration >= 40  # ~50ms with slack


def test_recorded_scope_session_finishes_after_scope_is_disabled(isolated_tracer):
    from tracelink import tracer

    tracer.start_scope("delete-work")
    tracer.disable_all_scopes()
    tracer.end_scope("delete-work")

    logs = tracer.get_logs()
    assert len(logs) == 2
    assert logs[0]["fn"] == "Tracer:start_scope"
    assert logs[1]["fn"] == "Tracer:end_scope"
    assert logs[1]["traceId"] == logs[0]["traceId"]


def test_master_switch_disables_everything(isolated_tracer, monkeypatch):
    from tracelink import tracer

    tracer.set_enabled(False)
    tracer.entry("x", "should be dropped", scope="any")
    assert tracer.get_logs() == []


# ---------------------------------------------------------------------------
# Level / outcome parity with JS
# ---------------------------------------------------------------------------


def test_level_is_emitted(isolated_tracer):
    from tracelink import tracer

    tracer.entry("router.py:x", "warned", {"a": 1}, level="warn", scope="s")
    log = tracer.get_logs()[-1]
    assert log["level"] == "warn"
    assert "outcome" not in log  # absent = call


def test_blocked_sets_outcome_level_and_reason(isolated_tracer):
    from tracelink import tracer

    tracer.blocked(
        "routes/work:delete", "DELETE rejected",
        reason="insufficient permission", data={"workId": "w_1"}, scope="s",
    )
    log = tracer.get_logs()[-1]
    assert log["outcome"] == "blocked"
    assert log["level"] == "warn"
    assert log["data"]["reason"] == "insufficient permission"
    assert log["data"]["workId"] == "w_1"


def test_intent_sets_outcome_and_honors_layer_override(isolated_tracer):
    from tracelink import tracer

    tracer.intent(
        "cart:checkout", "would checkout",
        reason="feature flag off", layer="X-CART", scope="s",
    )
    log = tracer.get_logs()[-1]
    assert log["outcome"] == "intent"
    assert log["level"] == "info"
    assert log["layer"] == "X-CART"
    assert log["data"]["reason"] == "feature flag off"


# ---------------------------------------------------------------------------
# Span duration + async + contextvars nesting
# ---------------------------------------------------------------------------


def test_sync_span_open_close_duration_and_nesting(isolated_tracer):
    from tracelink import tracer

    def work():
        tracer.db("repo.py:q", "query")  # inherits ambient context
        return 7

    ret = tracer.span("BE-ENTRY", "router.py:handle", "handle", work, scope="s")
    assert ret == 7

    logs = tracer.get_logs()
    assert len(logs) == 3
    open_ev, child, close_ev = logs
    # open has no duration/async; close carries both.
    assert "durationMs" not in open_ev and "async" not in open_ev
    assert close_ev["async"] is False
    assert isinstance(close_ev["durationMs"], int)
    assert close_ev["spanId"] == open_ev["spanId"]
    # child auto-nests under the span and shares the trace.
    assert child["parentSpanId"] == open_ev["spanId"]
    assert child["traceId"] == open_ev["traceId"]


def test_recorded_span_closes_after_scope_is_disabled(isolated_tracer):
    from tracelink import tracer

    tracer.span(
        "BE-ENTRY",
        "router.py:handle",
        "handle",
        tracer.disable_all_scopes,
        scope="buy-flow",
    )

    open_ev, close_ev = tracer.get_logs()
    assert close_ev["spanId"] == open_ev["spanId"]
    assert isinstance(close_ev["durationMs"], int)


def test_suppressed_span_stays_silent_when_enabled_mid_flight(isolated_tracer):
    from tracelink import tracer

    tracer.disable_all_scopes()

    def work():
        tracer.enable_scope("buy-flow")
        tracer.internal("svc.py:child", "child")

    tracer.span("BE-ENTRY", "router.py:handle", "handle", work, scope="buy-flow")

    assert tracer.get_logs() == []


def test_async_span_measures_duration_and_marks_async(isolated_tracer):
    import asyncio

    from tracelink import tracer

    async def scenario():
        async def work():
            await asyncio.sleep(0.02)
            tracer.internal("svc.py:step", "step")
            return "done"

        return await tracer.span("BE-ENTRY", "router.py:a", "a", work, scope="s")

    result = asyncio.run(scenario())
    assert result == "done"

    logs = tracer.get_logs()
    assert len(logs) == 3
    open_ev, child, close_ev = logs
    assert child["parentSpanId"] == open_ev["spanId"]
    assert close_ev["async"] is True
    assert close_ev["durationMs"] >= 15


def test_async_span_closes_after_scope_is_disabled(isolated_tracer):
    import asyncio

    from tracelink import tracer

    async def work():
        await asyncio.sleep(0.01)
        tracer.disable_all_scopes()

    asyncio.run(
        tracer.span("BE-ENTRY", "router.py:a", "a", work, scope="flow-1")
    )

    open_ev, close_ev = tracer.get_logs()
    assert close_ev["spanId"] == open_ev["spanId"]
    assert close_ev["async"] is True


def test_concurrent_async_spans_stay_isolated(isolated_tracer):
    import asyncio

    from tracelink import tracer

    async def scenario():
        async def flow(tag):
            async def body():
                await asyncio.sleep(0.01)
                tracer.internal("svc.py:child", f"c-{tag}")
            await tracer.span("BE-ENTRY", "svc.py:flow", f"open-{tag}", body, scope=tag)

        await asyncio.gather(flow("flow-1"), flow("flow-2"))

    asyncio.run(scenario())
    logs = tracer.get_logs()
    open1 = next(log for log in logs if log["msg"] == "open-flow-1")
    open2 = next(log for log in logs if log["msg"] == "open-flow-2")
    c1 = next(log for log in logs if log["msg"] == "c-flow-1")
    c2 = next(log for log in logs if log["msg"] == "c-flow-2")
    # Each child nests under its OWN span despite interleaved awaits.
    assert c1["parentSpanId"] == open1["spanId"]
    assert c2["parentSpanId"] == open2["spanId"]
    assert c1["parentSpanId"] != open2["spanId"]
    assert c2["parentSpanId"] != open1["spanId"]


def test_new_optional_fields_serialize_camelcase(isolated_tracer):
    """durationMs / async / outcome / level survive JSON round-trip camelCase."""
    from tracelink import tracer

    tracer.span("BE-ENTRY", "r.py:h", "h", lambda: None, scope="s")
    close_ev = tracer.get_logs()[-1]
    dumped = json.loads(json.dumps(close_ev, ensure_ascii=False))
    assert "durationMs" in dumped
    assert "async" in dumped
    assert dumped["async"] is False
