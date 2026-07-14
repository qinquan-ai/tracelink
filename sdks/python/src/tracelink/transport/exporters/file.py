"""Fail-safe local NDJSON and readable-text exporter."""

from __future__ import annotations

import json
import logging

from ...engine.types import TraceLog
from .paths import ndjson_path, readable_path

logger = logging.getLogger(__name__)


def _format_readable(log: TraceLog) -> str:
    lines = [f"{log['ts']} [{log['layer']}] [{log['fn']}]", f"  > {log['msg']}"]
    data = log.get("data", {})
    if data:
        lines.append("  > data:")
        for line in json.dumps(data, ensure_ascii=False, indent=2).split("\n"):
            lines.append(f"    {line}")
    lines.extend(["---", ""])
    return "\n".join(lines)


class FileExporter:
    """Write each TraceLog to the conventional local file pair."""

    def __call__(self, log: TraceLog) -> None:
        try:
            path = ndjson_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(log, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001 - exporters are fail-safe
            logger.debug("TraceLink NDJSON write failed: %s", exc)

        try:
            path = readable_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as stream:
                stream.write(_format_readable(log))
        except Exception as exc:  # noqa: BLE001 - exporters are fail-safe
            logger.debug("TraceLink readable write failed: %s", exc)

    def reset(self) -> None:
        for path in (ndjson_path(), readable_path()):
            try:
                if path.exists():
                    path.unlink()
            except Exception:  # noqa: BLE001 - reset is best-effort
                pass
