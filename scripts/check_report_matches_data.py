#!/usr/bin/env python3
import csv
import json
import re
import sys
from pathlib import Path


MARKERS = {
    "Baseline Rows": "baseline_rows",
    "Baseline Important Policy Misses": "baseline_important_policy_misses",
    "Baseline Policy Misses": "baseline_policy_misses",
    "Baseline Stale Memory Misses": "baseline_stale_memory_misses",
    "Experimental Scenario Count": "experimental_scenario_count",
    "Experimental Passed Scenarios": "experimental_passed_scenarios",
    "Experimental Warning Count": "experimental_warning_count",
    "Experimental Conflict Count": "experimental_conflict_count",
    "Experimental Stale Marker Count": "experimental_stale_marker_count",
    "Important Policy Miss Reduction": "important_policy_miss_reduction",
}


def parse_report(report_path: Path) -> dict[str, int]:
    content = report_path.read_text(encoding="utf-8")
    parsed: dict[str, int] = {}

    for label, key in MARKERS.items():
        match = re.search(rf"^{re.escape(label)}:\s*(\d+)%?$", content, re.MULTILINE)
        if not match:
            raise SystemExit(f"ERROR Missing report marker: {label}")
        parsed[key] = int(match.group(1))

    return parsed


def compute_baseline(scorecard_path: Path) -> dict[str, int]:
    with scorecard_path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    return {
        "baseline_rows": len(rows),
        "baseline_policy_misses": sum(1 for row in rows if row["miss_type"] == "policy_miss"),
        "baseline_stale_memory_misses": sum(1 for row in rows if row["miss_type"] == "stale_memory"),
        "baseline_important_policy_misses": sum(
            1
            for row in rows
            if row["miss_type"] == "policy_miss" and row["severity"] in {"critical", "high"}
        ),
    }


def compute_experimental(summary_path: Path) -> dict[str, int]:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))

    return {
        "experimental_scenario_count": int(summary["scenarioCount"]),
        "experimental_passed_scenarios": int(summary["passedScenarios"]),
        "experimental_warning_count": int(summary["totals"]["warnings"]),
        "experimental_conflict_count": int(summary["totals"]["conflicts"]),
        "experimental_stale_marker_count": int(summary["totals"]["staleMarkers"]),
    }


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: python check_report_matches_data.py <report.md> <baseline-scorecard.csv> <summary.json>"
        )

    report_path = Path(sys.argv[1])
    scorecard_path = Path(sys.argv[2])
    summary_path = Path(sys.argv[3])

    report = parse_report(report_path)
    baseline = compute_baseline(scorecard_path)
    experimental = compute_experimental(summary_path)

    expected = {**baseline, **experimental}
    baseline_important = baseline["baseline_important_policy_misses"]
    experimental_important = 0
    expected["important_policy_miss_reduction"] = 0 if baseline_important == 0 else round(
        ((baseline_important - experimental_important) / baseline_important) * 100
    )

    mismatches = []
    for key, expected_value in expected.items():
      if report.get(key) != expected_value:
            mismatches.append(f"{key}: report={report.get(key)} expected={expected_value}")

    if mismatches:
        raise SystemExit("ERROR Report/data mismatch\n" + "\n".join(mismatches))

    print("OK Report markers match baseline scorecard and summary data")


if __name__ == "__main__":
    main()
