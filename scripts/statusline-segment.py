#!/usr/bin/env python3
"""One status-line segment: how long the prompt cache has left, or what resuming cold will cost.

Claude Code pipes its status-line JSON on stdin. This reads the `prompt_cache` object from it
(Claude Code 2.1.251 and later: `warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`) and prints
a single short segment. With no cache data it prints nothing at all, so it can be dropped into
any status line without leaving a gap.

Wire it into your own status-line script, which WarmProof never edits for you:

    segment=$(printf '%s' "$input" | python3 -I /path/to/WarmProof/scripts/statusline-segment.py)

Every field is read as data and formatted in Python. Nothing from the JSON is ever handed to a
shell, which is the failure mode of doing this with `jq` and shell arithmetic.

    python3 -I scripts/statusline-segment.py --self-test
"""
from __future__ import annotations

import json
import sys
import time

SEGMENT_PREFIX = "cache"


def fmt_tokens(count: int) -> str:
    """A token count at a glance: 850, 201k, 1.4M."""
    if count >= 1_000_000:
        return f"{count / 1e6:.1f}M"
    if count >= 1000:
        return f"{round(count / 1000)}k"
    return str(count)


def fmt_left(seconds: int) -> str:
    """Whole minutes remaining, rounded up, as 42m or 1h30m."""
    minutes = (seconds + 59) // 60
    if minutes < 60:
        return f"{minutes}m"
    return f"{minutes // 60}h{minutes % 60:02d}m"


def whole_number(value: object) -> int | None:
    """An integer from a JSON value, or None. Booleans and junk are not numbers here."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def segment(payload: object, now: float) -> str:
    """The line to print for this status-line payload; empty when there is nothing to say."""
    if not isinstance(payload, dict):
        return ""
    cache = payload.get("prompt_cache")
    if not isinstance(cache, dict):
        return ""

    expires_at = whole_number(cache.get("expires_at"))
    if expires_at is None:
        return ""

    recache = whole_number(cache.get("recache_tokens_if_cold")) or 0
    seconds_left = expires_at - int(now)
    gone = cache.get("warm") is False or seconds_left <= 0

    if gone:
        if recache:
            return f"{SEGMENT_PREFIX} cold · next msg re-writes {fmt_tokens(recache)}"
        return f"{SEGMENT_PREFIX} cold"

    # Only the two lifetimes the API actually has are worth showing; anything else is noise.
    lifetime = cache.get("ttl") if cache.get("ttl") in ("5m", "1h") else ""
    suffix = f" ({lifetime})" if lifetime else ""
    return f"{SEGMENT_PREFIX} {fmt_left(seconds_left)} left{suffix}"


def self_test() -> int:
    now = 1_800_000_000
    cases = [
        # Nothing to report.
        ({}, ""),
        ({"prompt_cache": {}}, ""),
        # Warm, with and without a known lifetime.
        ({"prompt_cache": {"warm": True, "ttl": "1h", "expires_at": now + 42 * 60, "recache_tokens_if_cold": 201000}}, "cache 42m left (1h)"),
        ({"prompt_cache": {"warm": True, "ttl": "1h", "expires_at": now + 90 * 60}}, "cache 1h30m left (1h)"),
        # Cold, with and without a re-write cost to quote.
        ({"prompt_cache": {"warm": False, "expires_at": now - 10, "recache_tokens_if_cold": 330316}}, "cache cold · next msg re-writes 330k"),
        ({"prompt_cache": {"warm": False, "expires_at": now - 10}}, "cache cold"),
        # A payload that tries to smuggle a command through a numeric field is simply not a number.
        ({"prompt_cache": {"warm": True, "expires_at": "$(touch /tmp/pwned)"}}, ""),
        # An unknown lifetime is dropped rather than printed back.
        ({"prompt_cache": {"warm": True, "ttl": "evil", "expires_at": str(now + 300)}}, "cache 5m left"),
    ]
    failures = [(payload, want, got) for payload, want in cases if (got := segment(payload, now)) != want]
    for payload, want, got in failures:
        print(f"FAIL {payload!r}: want {want!r}, got {got!r}")
    print(f"statusline-segment self-test: {'FAIL' if failures else 'ok'}, {len(cases)} cases")
    return 1 if failures else 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        # A status line must never be the thing that breaks the prompt.
        return 0
    line = segment(payload, time.time())
    if line:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
