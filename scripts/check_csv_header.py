#!/usr/bin/env python3
"""
Verify CSV file has expected header columns in correct order.
"""
import sys
import csv
from pathlib import Path

def check_csv_header(filepath: Path, expected_columns: list[str]) -> tuple[bool, str]:
    """Check if CSV has expected header."""
    if not filepath.exists():
        return False, f"File not found: {filepath}"
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            
            if header is None:
                return False, "CSV file is empty"
            
            if header != expected_columns:
                return False, f"Header mismatch.\nExpected: {expected_columns}\nGot: {header}"
            
            return True, "header_ok"
    
    except Exception as e:
        return False, f"Error reading CSV: {e}"

def main():
    if len(sys.argv) < 3:
        print("Usage: check_csv_header.py <csv_file> <col1> <col2> ...")
        sys.exit(1)
    
    filepath = Path(sys.argv[1])
    expected_columns = sys.argv[2:]
    
    ok, message = check_csv_header(filepath, expected_columns)
    
    if ok:
        print(f"OK {filepath.name}: {message}")
        sys.exit(0)
    else:
        print(f"ERROR {filepath.name}: {message}")
        sys.exit(1)

if __name__ == '__main__':
    main()
