#!/usr/bin/env python3
"""
Count scenarios in the evaluation corpus and verify minimum threshold.
"""
import sys
import re
from pathlib import Path


def count_scenarios(file_path: str, min_count: int = 8) -> int:
    """Count scenario headings in the corpus file."""
    if not Path(file_path).exists():
        print(f"ERROR: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Match scenario headings like "## Scenario 1:", "## Scenario 2:", etc.
    scenario_pattern = r'^##\s+Scenario\s+\d+:'
    scenarios = re.findall(scenario_pattern, content, re.MULTILINE)
    
    count = len(scenarios)
    
    print(f"Found {count} scenarios in {file_path}")
    
    if count < min_count:
        print(f"ERROR: Expected at least {min_count} scenarios, found {count}", file=sys.stderr)
        sys.exit(1)
    
        print(f"OK Corpus meets minimum threshold ({count} >= {min_count})")
    return count


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python count_scenarios.py <file_path> [--min N]", file=sys.stderr)
        sys.exit(1)
    
    file_path = sys.argv[1]
    min_count = 8
    
    # Parse --min flag if provided
    if len(sys.argv) >= 4 and sys.argv[2] == "--min":
        try:
            min_count = int(sys.argv[3])
        except ValueError:
            print(f"ERROR: Invalid minimum count: {sys.argv[3]}", file=sys.stderr)
            sys.exit(1)
    
    count_scenarios(file_path, min_count)
