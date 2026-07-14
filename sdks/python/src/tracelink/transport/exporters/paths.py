"""Resolve local trace-file paths from env / project root.

Mirrors the shared Receiver layout (`receiver/service/handler.ts`): a single
`.tracelink/` directory holding `trace.ndjson` (machine-readable NDJSON) and
`trace.log` (human-readable). This keeps Python and JS traces on the same
on-disk convention so both ends stay correlated by `traceId`.
"""

import os
from pathlib import Path

#: Log subdirectory — must match the JS receiver's `subdir` default.
TRACELINK_DIR = ".tracelink"
#: NDJSON — machine-readable, one JSON TraceLog per line (JS: NDJSON_FILE).
NDJSON_FILE = "trace.ndjson"
#: Human-readable multi-line log (JS: READABLE_FILE).
READABLE_FILE = "trace.log"


def resolve_project_root() -> Path:
    """Resolve the project root where the `.tracelink/` dir lives.

    Priority:
      1. TRACELINK_DIR env (absolute path)
      2. Walk up from cwd until we find a package.json / pyproject.toml / etc.
      3. Current working directory
    """
    env_dir = os.getenv("TRACELINK_DIR")
    if env_dir:
        return Path(env_dir)

    cwd = Path.cwd()
    # Walk up looking for project markers
    for parent in [cwd, *cwd.parents]:
        if any((parent / m).exists() for m in ("package.json", "pyproject.toml", "Cargo.toml", "go.mod")):
            return parent

    return cwd


def tracelink_dir() -> Path:
    return resolve_project_root() / TRACELINK_DIR


def ndjson_path() -> Path:
    return tracelink_dir() / NDJSON_FILE


def readable_path() -> Path:
    return tracelink_dir() / READABLE_FILE
