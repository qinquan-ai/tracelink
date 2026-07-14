"""Time and ID helpers."""

from __future__ import annotations

import os
import time
from datetime import datetime


def now_ms() -> int:
    return int(time.time() * 1000)


def monotonic_ms() -> int:
    """Return a monotonic millisecond clock for elapsed-time measurements."""
    return time.perf_counter_ns() // 1_000_000


def format_ts(ts: int | None = None) -> str:
    if ts is None:
        ts = now_ms()
    dt = datetime.fromtimestamp(ts / 1000)
    return f"[{dt.strftime('%H:%M:%S')}.{dt.microsecond // 1000:03d}]"


def make_trace_id(scope: str) -> str:
    """Generate traceId with format `<scope>-<timestamp6>-<rand3>`."""
    ts_suffix = str(now_ms())[-6:]
    rand_suffix = os.urandom(2).hex()[:3]
    return f"{scope}-{ts_suffix}-{rand_suffix}"


def make_span_id(counter: int) -> str:
    return f"span-{counter}"
