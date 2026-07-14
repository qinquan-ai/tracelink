"""Type definitions for TraceLink Python."""

import re
from typing import Any, Literal, TypedDict

TRACE_PROTOCOL_VERSION = "1"
TRACE_PROTOCOL_COMPATIBLE_VERSIONS = ("1", "0.5.0", "0.4.0")

# ---------------------------------------------------------------------------
# Built-in layers are shared by every SDK through the protocol. Custom layers use X-*.
# ---------------------------------------------------------------------------

BUILTIN_LAYERS: list[str] = [
    "FE-ACTION",
    "FE-API",
    "FE-WS",
    "FE-UI",
    "BE-ENTRY",
    "BE-INTERNAL",
    "BE-DB",
    "BE-WS",
]

BuiltinLayer = Literal[
    "FE-ACTION",
    "FE-API",
    "FE-WS",
    "FE-UI",
    "BE-ENTRY",
    "BE-INTERNAL",
    "BE-DB",
    "BE-WS",
]

# CustomLayer is a structural type for IDE hints; the runtime accepts any
# string starting with "X-".
CustomLayerStr = str  # noqa: Y042 — structural marker; see normalize_layer

TraceLayer = str  # widened from Literal[] to allow custom layers


_X_LAYER_RE = re.compile(r"^X-[A-Z0-9][A-Z0-9-]*$")


def is_builtin_layer(layer: str) -> bool:
    """True if `layer` is one of the 8 built-in FE-*/BE-* values."""
    return layer in BUILTIN_LAYERS


def is_custom_layer(layer: str) -> bool:
    """True if `layer` follows the `X-*` naming convention."""
    return bool(_X_LAYER_RE.match(layer))


def normalize_layer(input_: str) -> str:
    """Light validation/normalization at the tracer boundary.

    - Empty / None-ish → 'FE-ACTION' (last-resort default).
    - FE-/BE-/X- prefix: kept as-is (case-sensitive on the prefix).
    - Anything else: prefix 'X-'.
    """
    if not input_:
        return "FE-ACTION"
    trimmed = input_.strip()
    if (
        trimmed.startswith("FE-")
        or trimmed.startswith("BE-")
        or trimmed.startswith("X-")
    ):
        return trimmed
    return f"X-{trimmed}"


# ---------------------------------------------------------------------------
# Severity + interaction outcome (aligned with JS `LogLevel` / `TraceOutcome`)
# ---------------------------------------------------------------------------

# Optional severity hint — same union as the JS `LogLevel`. Purely optional;
# omit it and nothing downstream breaks.
LogLevel = Literal["debug", "info", "warn", "error"]

# Interaction outcome — "what actually happened" for a call. Optional; an absent
# `outcome` MUST be treated as `"call"` by consumers. The human-readable reason
# travels in `data["reason"]` — there is NO top-level `reason` field.
#   - "call"    : normal call that actually happened (default/absent case).
#   - "blocked" : intercepted / rejected / not really executed.
#   - "intent"  : an intent or no-op (wanted to, but didn't; or a placeholder).
Outcome = Literal["call", "blocked", "intent"]
# Alias kept in sync with the JS type name for cross-language readability.
TraceOutcome = Outcome


# ---------------------------------------------------------------------------
# Event payload
# ---------------------------------------------------------------------------

class _RequiredTraceLog(TypedDict):
    ts: str
    layer: TraceLayer
    fn: str
    msg: str
    data: dict[str, Any]
    traceId: str
    spanId: str


# Functional syntax is required because `async` is a reserved keyword.
_OptionalTraceLog = TypedDict(
    "_OptionalTraceLog",
    {
        "level": LogLevel,
        "outcome": Outcome,
        "scope": str,
        "userId": str,
        "parentSpanId": str,
        "durationMs": int,
        "async": bool,
    },
    total=False,
)


class TraceLog(_RequiredTraceLog, _OptionalTraceLog):
    """A single JSON-serializable trace event."""


class ScopeInfo(TypedDict):
    id: str
    start_time: float
    recording: bool


class LayerMeta(TypedDict, total=False):
    """User-supplied metadata for a custom X-* layer."""

    description: str
    color: str
