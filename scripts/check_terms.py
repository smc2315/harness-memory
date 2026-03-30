#!/usr/bin/env python3
"""
Verification script: check_terms.py

Verifies that the adapter document contains all required terms.
Ensures the adapter specification uses correct hook names and interfaces.

Usage:
  python scripts/check_terms.py <file> <term1> <term2> ...

Example:
  python scripts/check_terms.py docs/spec/opencode-adapter.md \
    session_start before_model before_tool after_tool HarnessPort
"""

import sys
import re
from pathlib import Path


def check_terms(file_path: str, required_terms: list[str]) -> bool:
    """
    Check if all required terms are present in the file.
    
    Args:
        file_path: Path to the file to check
        required_terms: List of terms that must be present
        
    Returns:
        True if all terms found, False otherwise
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
    
    all_found = True
    for term in required_terms:
        # Use word boundary regex to match whole terms
        pattern = r'\b' + re.escape(term) + r'\b'
        if re.search(pattern, content, re.IGNORECASE):
            print(f"OK Found term: {term}")
        else:
            print(f"ERROR Missing term: {term}")
            all_found = False
    
    if all_found:
        print("\nOK All required terms found.")
        return True
    else:
        print("\nERROR Some required terms are missing.")
        return False


def main():
    if len(sys.argv) < 3:
        print("Usage: python check_terms.py <file> <term1> <term2> ...")
        print("Example: python check_terms.py docs/spec/opencode-adapter.md session_start before_model")
        sys.exit(1)
    
    file_path = sys.argv[1]
    required_terms = sys.argv[2:]
    
    success = check_terms(file_path, required_terms)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
