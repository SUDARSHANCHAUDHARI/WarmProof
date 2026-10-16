#!/usr/bin/env python3
"""Fails if anything WarmProof spends or sends bypasses its logged wrappers.

Every model fork, compaction, host command and network request must go through askModel,
askCompact, askHost or askWeb, each of which writes a `request` row. That is what makes the
evidence log complete rather than merely plausible.

Scans every hooks/*.ts file, not only the engine, so a raw call added to a helper module is
caught too.

Run: python3 -I scripts/check-evidence.py   (0 = clean, 1 = a raw call was found)
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOOKS = ROOT / "hooks"

SPENDS = re.compile(
    r"\$\.(model\.fork|model\.complete|session\.compact|http\.fetch|process\.run|process\.spawn)\s*\("
)
WRAPPERS = {"askModel", "askCompact", "askHost", "askWeb"}
DECLARATION = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]", re.M)


def spans(text: str) -> list[tuple[str, int, int]]:
    """(name, start, end) for each top-level function, found by matching its braces."""
    found = []
    for match in DECLARATION.finditer(text):
        opened = text.find("{", match.end())
        if opened == -1:
            continue
        depth, i = 0, opened
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        found.append((match.group(1), match.start(), i))
    return found


def main() -> int:
    sources = sorted(HOOKS.glob("*.ts"))
    if not sources:
        print("check-evidence: no hooks/*.ts found")
        return 1

    defined: set[str] = set()
    problems: list[str] = []
    checked = 0

    for source in sources:
        text = source.read_text()
        functions = spans(text)
        defined |= {name for name, _, _ in functions}
        for call in SPENDS.finditer(text):
            checked += 1
            enclosing = [name for name, start, end in functions if start <= call.start() <= end]
            innermost = enclosing[-1] if enclosing else None
            if innermost in WRAPPERS:
                continue
            line = text.count("\n", 0, call.start()) + 1
            where = innermost or "a hook body"
            problems.append(
                f"{source.relative_to(ROOT)}:{line}: raw $.{call.group(1)}( outside the logged wrappers (in {where})"
            )

    missing = WRAPPERS - defined
    if missing:
        print(f"check-evidence: wrapper(s) not defined anywhere: {', '.join(sorted(missing))}")
        return 1

    for problem in problems:
        print(problem)
    verdict = "FAIL" if problems else "ok"
    print(f"check-evidence: {verdict}, {checked} spending call(s) checked across {len(sources)} file(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
