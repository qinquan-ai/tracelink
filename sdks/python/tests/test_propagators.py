from tracelink import create_trace_headers, extract_trace_context
from tracelink.runtime.context import SpanContext, reset_span, set_span


def test_http_context_round_trip() -> None:
    context = extract_trace_context(
        {
            "X-Trace-Id": "trace-1",
            "X-Parent-Span-Id": "span-2",
            "X-Debug-Scopes": '["checkout"]',
        }
    )
    assert context.trace_id == "trace-1"
    assert context.parent_span_id == "span-2"
    assert context.scopes == frozenset({"checkout"})


def test_create_trace_headers_uses_ambient_span() -> None:
    token = set_span(SpanContext("span-9", "trace-9", "checkout"))
    try:
        headers = create_trace_headers(scopes=["checkout"])
    finally:
        reset_span(token)

    assert headers["x-trace-id"] == "trace-9"
    assert headers["x-parent-span-id"] == "span-9"
    assert headers["x-debug-scopes"] == '["checkout"]'


def test_trace_override_does_not_inherit_an_unrelated_span() -> None:
    token = set_span(SpanContext("span-a", "trace-a"))
    try:
        headers = create_trace_headers(trace_id="trace-b", scopes=[])
    finally:
        reset_span(token)

    assert headers["x-trace-id"] == "trace-b"
    assert "x-parent-span-id" not in headers
