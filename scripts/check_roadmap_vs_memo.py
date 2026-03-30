#!/usr/bin/env python3
import re
import sys
from pathlib import Path


FORBIDDEN_IF_CONTINUE = [
    "vector retrieval",
    "graph storage",
    "autonomous promotion",
    "personal-memory",
]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: python check_roadmap_vs_memo.py <roadmap.md> <continue-kill-memo.md>"
        )

    roadmap_path = Path(sys.argv[1])
    memo_path = Path(sys.argv[2])

    roadmap = roadmap_path.read_text(encoding="utf-8")
    memo = memo_path.read_text(encoding="utf-8")

    memo_continue = bool(re.search(r"\bCONTINUE\b|\bContinue\b", memo))
    memo_stop = bool(re.search(r"\bSTOP\b|\bstop\b", memo)) and not memo_continue

    if memo_continue:
        if "live side-by-side benchmark" not in roadmap.lower() and "live benchmark" not in roadmap.lower():
            raise SystemExit("ERROR Roadmap must include a live benchmark phase when memo recommends continue")

        lowered = roadmap.lower()
        bad = [term for term in FORBIDDEN_IF_CONTINUE if term in lowered and "explicitly deferred" not in lowered]
        if bad:
            raise SystemExit("ERROR Roadmap includes deferred scope: " + ", ".join(bad))

        print("OK Roadmap matches continue recommendation")
        return

    if memo_stop:
        if "phase" in roadmap.lower():
            raise SystemExit("ERROR Stop recommendation should not include active roadmap phases")
        print("OK Roadmap matches stop recommendation")
        return

    raise SystemExit("ERROR Could not determine recommendation from memo")


if __name__ == "__main__":
    main()
