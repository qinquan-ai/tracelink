import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parents[3] / "protocol" / "fixtures"
REQUIRED_FIELDS = {"ts", "layer", "fn", "msg", "data", "traceId", "spanId"}
VALID_LEVELS = {"debug", "info", "warn", "error"}
VALID_OUTCOMES = {"call", "blocked", "intent"}


def read_fixture(name: str):
    lines = (FIXTURE_DIR / name).read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


@pytest.mark.parametrize(
    "name",
    [
        "plain-call.ndjson",
        "nested-span.ndjson",
        "blocked-outcome.ndjson",
        "span-duration.ndjson",
    ],
)
def test_golden_fixture_matches_wire_contract(name: str) -> None:
    records = read_fixture(name)
    assert records

    for record in records:
        assert REQUIRED_FIELDS <= record.keys()
        assert isinstance(record["data"], dict)
        assert isinstance(record["traceId"], str)
        assert isinstance(record["spanId"], str)
        if "level" in record:
            assert record["level"] in VALID_LEVELS
        if "outcome" in record:
            assert record["outcome"] in VALID_OUTCOMES
        assert json.loads(json.dumps(record, ensure_ascii=False)) == record


def test_nested_span_fixture_links_children_to_parent() -> None:
    parent, *children = read_fixture("nested-span.ndjson")
    assert children
    assert all(child["traceId"] == parent["traceId"] for child in children)
    assert all(child["parentSpanId"] == parent["spanId"] for child in children)


def test_span_duration_fixture_is_open_close_pair() -> None:
    opened, closed = read_fixture("span-duration.ndjson")
    assert opened["spanId"] == closed["spanId"]
    assert opened["traceId"] == closed["traceId"]
    assert "durationMs" not in opened and "async" not in opened
    assert isinstance(closed["durationMs"], int)
    assert isinstance(closed["async"], bool)
