#!/usr/bin/env python3
"""
Check that a markdown document contains required sections.

Usage:
    python check_doc_sections.py <file_path> <section1> <section2> ...

Example:
    python check_doc_sections.py docs/product/wedge.md "First User" "First Wedge"

Exit codes:
    0: All required sections found
    1: Missing sections or file not found
"""

import sys
import re
from pathlib import Path


def find_sections(content: str) -> set[str]:
    """Extract all markdown headings from content."""
    # Match markdown headings: ## Heading or # Heading
    pattern = r'^#{1,6}\s+(.+)$'
    sections = set()
    
    for line in content.split('\n'):
        match = re.match(pattern, line.strip())
        if match:
            sections.add(match.group(1).strip())
    
    return sections


def main():
    if len(sys.argv) < 3:
        print("Error: Missing arguments", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    
    file_path = Path(sys.argv[1])
    required_sections = sys.argv[2:]
    
    if not file_path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)
    
    content = file_path.read_text(encoding='utf-8')
    found_sections = find_sections(content)
    
    missing = []
    for required in required_sections:
        if required not in found_sections:
            missing.append(required)
    
    if missing:
        print(f"Missing required sections in {file_path}:", file=sys.stderr)
        for section in missing:
            print(f"  - {section}", file=sys.stderr)
        print(f"\nFound sections:", file=sys.stderr)
        for section in sorted(found_sections):
            print(f"  - {section}", file=sys.stderr)
        sys.exit(1)

    print(f"OK All required sections present in {file_path}")
    for section in required_sections:
        print(f"  OK {section}")
    sys.exit(0)


if __name__ == '__main__':
    main()
