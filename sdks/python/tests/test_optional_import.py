"""Regression: `import tracelink` must work with only the stdlib base SDK.

A development iteration used an unconditional `from .middleware import TraceMiddleware`
in `__init__.py`, and `middleware` unconditionally imported starlette (an
optional `[fastapi]` extra). Users who ran a bare `pip install tracelink` hit
`ModuleNotFoundError: starlette` on the very first `import tracelink`.

These tests run in a fresh subprocess so they assert real import behavior
regardless of what the current test session already loaded.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PACKAGE_SRC = Path(__file__).parents[1] / "src"


def _run(code: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    existing_path = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(PACKAGE_SRC) + (os.pathsep + existing_path if existing_path else "")
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=env,
    )


def test_import_does_not_pull_in_starlette() -> None:
    # A clean interpreter: importing the package must not eagerly import
    # starlette, so bare installs (without the fastapi extra) work.
    result = _run(
        "import sys, tracelink; "
        "assert 'starlette' not in sys.modules, 'tracelink eagerly imported starlette'; "
        "assert tracelink.tracer is not None; "
        "assert type(tracelink.tracer).__name__ == 'Tracer'; "
        "assert not hasattr(tracelink, 'debug_tracer'); "
        "assert not hasattr(tracelink, 'DebugTracer'); "
        "print('OK', tracelink.__version__)"
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_trace_middleware_is_lazily_resolvable() -> None:
    # starlette is installed in the dev/test env, so accessing the attribute
    # must succeed (and only then import starlette).
    result = _run(
        "import tracelink; "
        "tm = tracelink.TraceMiddleware; "
        "assert tm is not None; "
        "print('OK', tm.__name__)"
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout
