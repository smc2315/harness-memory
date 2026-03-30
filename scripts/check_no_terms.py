#!/usr/bin/env python3
"""
Verification script: check_no_terms.py

Verifies that the adapter document does NOT contain forbidden coupling patterns.
Ensures the adapter maintains separation between core and OpenCode-specific logic.

Usage:
  python scripts/check_no_terms.py <file> <forbidden1> <forbidden2> ...

Example:
  python scripts/check_no_terms.py docs/spec/opencode-adapter.md \
    "store memories in opencode metadata" \
    "permission.ask for memory warnings"
"""

import sys
import re
from pathlib import Path


def check_no_terms(file_path: str, forbidden_terms: list[str]) -> bool:
    """
    Check if forbidden terms are NOT present in the file.
    
    Args:
        file_path: Path to the file to check
        forbidden_terms: List of terms that must NOT be present
        
    Returns:
        True if no forbidden terms found, False otherwise
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except FileNotFoundError:
        print(f"ERROR File not found: {file_path}")
        return False
    except Exception as e:
        print(f"ERROR reading file: {e}")
        return False
    
    all_absent = True
    for term in forbidden_terms:
        # Use case-insensitive search for forbidden patterns
        if re.search(re.escape(term), content, re.IGNORECASE):
            print(f"ERROR Forbidden term found: {term}")
            all_absent = False
        else:
            print(f"OK Forbidden term not found: {term}")
    
    if all_absent:
        print("\nOK All forbidden terms absent.")
        return True
    else:
        print("\nERROR Some forbidden terms are present.")
        return False


def main():
    if len(sys.argv) < 3:
        print("Usage: python check_no_terms.py <file> <forbidden1> <forbidden2> ...")
        print("Example: python check_no_terms.py docs/spec/opencode-adapter.md \"store memories in opencode metadata\"")
        sys.exit(1)
    
    file_path = sys.argv[1]
    forbidden_terms = sys.argv[2:]
    
    success = check_no_terms(file_path, forbidden_terms)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
