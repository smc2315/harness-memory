#!/usr/bin/env python3
"""
Check that a runbook references the same corpus file.
"""
import sys
from pathlib import Path


def check_runbook_uses_corpus(runbook_path: str, corpus_path: str) -> bool:
    """Check that runbook references the corpus file."""
    if not Path(runbook_path).exists():
        print(f"ERROR: Runbook not found: {runbook_path}", file=sys.stderr)
        sys.exit(1)
    
    if not Path(corpus_path).exists():
        print(f"ERROR: Corpus not found: {corpus_path}", file=sys.stderr)
        sys.exit(1)
    
    corpus_filename = Path(corpus_path).name
    
    with open(runbook_path, 'r', encoding='utf-8') as f:
        runbook_content = f.read()
    
    if corpus_filename in runbook_content or "task-corpus" in runbook_content.lower():
        print(f"OK Runbook references corpus file: {corpus_filename}")
        return True
    else:
        print(f"✗ Runbook does not reference corpus file: {corpus_filename}", file=sys.stderr)
        print(f"  Runbook should reference the same task corpus used in experimental condition", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python check_runbook_uses_corpus.py <runbook_path> <corpus_path>", file=sys.stderr)
        sys.exit(1)
    
    runbook_path = sys.argv[1]
    corpus_path = sys.argv[2]
    
    check_runbook_uses_corpus(runbook_path, corpus_path)
