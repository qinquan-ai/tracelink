import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import Response

from tracelink import tracer
from tracelink.extensions.frameworks.fastapi import TraceMiddleware, get_trace_id


def make_request(
    *, trace_id: str | None, scopes: str, parent_span_id: str | None = None
) -> Request:
    headers = [(b"x-debug-scopes", scopes.encode("utf-8"))]
    if trace_id is not None:
        headers.append((b"x-trace-id", trace_id.encode("utf-8")))
    if parent_span_id is not None:
        headers.append((b"x-parent-span-id", parent_span_id.encode("utf-8")))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": headers,
        }
    )


@pytest.fixture(autouse=True)
def reset_tracer(tmp_path, monkeypatch):
    monkeypatch.setenv("TRACELINK_DIR", str(tmp_path))
    tracer._enabled = True
    tracer._enabled_scopes = {"*"}
    tracer._logs = []
    tracer._active_traces = {}
    tracer._span_counter = 0
    tracer._exporters = []
    tracer._http_exporter = None
    yield
    tracer._logs = []
    tracer._enabled_scopes = {"*"}


def test_parse_scopes_accepts_json_array() -> None:
    assert TraceMiddleware._parse_scopes('["delete-work", "board-self"]') == {
        "delete-work",
        "board-self",
    }


def test_parse_scopes_preserves_explicit_empty_array() -> None:
    assert TraceMiddleware._parse_scopes("[]") == set()


def test_parse_scopes_rejects_non_json_protocol() -> None:
    assert TraceMiddleware._parse_scopes("delete-work, board-self") is None


@pytest.mark.asyncio
async def test_empty_scope_header_disables_request_collection() -> None:
    middleware = TraceMiddleware(lambda scope, receive, send: None)
    request = make_request(trace_id="trace-empty", scopes="[]")

    async def call_next(_: Request) -> Response:
        tracer.entry("router.py:empty", "must not emit", scope="board-self")
        return Response()

    await middleware.dispatch(request, call_next)

    assert tracer.get_logs() == []
    assert tracer.get_enabled_scopes() == ["*"]
    assert get_trace_id() == "no-trace"


@pytest.mark.asyncio
async def test_request_trace_id_reaches_tracer_events() -> None:
    middleware = TraceMiddleware(lambda scope, receive, send: None)
    request = make_request(trace_id="frontend-trace", scopes='["checkout"]')

    async def call_next(_: Request) -> Response:
        tracer.entry("router.py:checkout", "entered", scope="checkout")
        return Response()

    response = await middleware.dispatch(request, call_next)

    assert response.headers["x-trace-id"] == "frontend-trace"
    assert tracer.get_logs()[0]["traceId"] == "frontend-trace"
    assert get_trace_id() == "no-trace"


@pytest.mark.asyncio
async def test_request_parent_span_reaches_backend_entry() -> None:
    middleware = TraceMiddleware(lambda scope, receive, send: None)
    request = make_request(
        trace_id="frontend-trace",
        parent_span_id="frontend-span",
        scopes='["checkout"]',
    )

    async def call_next(_: Request) -> Response:
        tracer.entry("router.py:checkout", "entered", scope="checkout")
        return Response()

    await middleware.dispatch(request, call_next)

    assert tracer.get_logs()[0]["parentSpanId"] == "frontend-span"


@pytest.mark.asyncio
async def test_parent_without_trace_id_is_not_linked_to_a_generated_trace() -> None:
    middleware = TraceMiddleware(lambda scope, receive, send: None)
    request = make_request(
        trace_id=None,
        parent_span_id="orphan-span",
        scopes='["checkout"]',
    )

    async def call_next(_: Request) -> Response:
        tracer.entry("router.py:checkout", "entered", scope="checkout")
        return Response()

    await middleware.dispatch(request, call_next)

    assert "parentSpanId" not in tracer.get_logs()[0]


@pytest.mark.asyncio
async def test_concurrent_requests_keep_scope_overrides_isolated() -> None:
    middleware = TraceMiddleware(lambda scope, receive, send: None)

    async def run_request(tag: str, other: str) -> None:
        request = make_request(trace_id=f"trace-{tag}", scopes=f'["{tag}"]')

        async def call_next(_: Request) -> Response:
            await asyncio.sleep(0)
            tracer.entry(f"router.py:{tag}", f"keep-{tag}", scope=tag)
            tracer.entry(f"router.py:{other}", f"drop-{tag}", scope=other)
            return Response()

        await middleware.dispatch(request, call_next)

    await asyncio.gather(
        run_request("scope-a", "scope-b"),
        run_request("scope-b", "scope-a"),
    )

    logs = tracer.get_logs()
    assert {log["msg"] for log in logs} == {"keep-scope-a", "keep-scope-b"}
    assert {log["traceId"] for log in logs} == {"trace-scope-a", "trace-scope-b"}
