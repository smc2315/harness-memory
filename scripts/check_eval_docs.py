#!/usr/bin/env python3
"""
Verify evaluation documentation files have required structure.
"""
import sys
import argparse
from pathlib import Path

REQUIRED_HEADINGS = {
    'miss-taxonomy.md': [
        '# Miss Taxonomy',
        '## Purpose',
        '## Miss Categories',
        '### 1. Policy Miss',
        '### 2. Activation Miss',
        '### 3. Stale Memory',
        '### 4. False Positive Warning',
        '## Boundary Cases',
        '## Usage Notes'
    ],
    'annotation-rubric.md': [
        '# Annotation Rubric',
        '## Purpose',
        '## Severity Levels',
        '### Critical',
        '### High',
        '### Medium',
        '### Low',
        '## Annotation Process',
        '## Baseline Conditions',
        '## Reviewer Instructions',
        '## Edge Cases',
        '## Reporting Format'
    ]
}

def check_file(filepath: Path) -> tuple[bool, list[str]]:
    """Check if file has all required headings."""
    if not filepath.exists():
        return False, [f"File not found: {filepath}"]
    
    content = filepath.read_text(encoding='utf-8')
    filename = filepath.name
    
    if filename not in REQUIRED_HEADINGS:
        return False, [f"Unknown file: {filename}"]
    
    required = REQUIRED_HEADINGS[filename]
    missing = []
    
    for heading in required:
        if heading not in content:
            missing.append(heading)
    
    if missing:
        return False, [f"Missing headings in {filename}:"] + missing
    
    # Check for empty sections (heading followed immediately by another heading)
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if line.startswith('#'):
            if line.startswith('# ') and i < len(lines) - 1:
                continue
            # Look ahead for content before next heading
            has_content = False
            for j in range(i + 1, min(i + 10, len(lines))):
                next_line = lines[j].strip()
                if next_line.startswith('#'):
                    has_content = True
                    break
                if next_line and not next_line.startswith('**') and not next_line.startswith('---'):
                    has_content = True
                    break
            
            if not has_content and i < len(lines) - 1:
                # Allow some headings to be immediately followed by subheadings
                next_heading = lines[i + 1].strip() if i + 1 < len(lines) else ""
                if not next_heading.startswith('#'):
                    return False, [f"Empty section detected: {line}"]
    
    return True, []

def main():
    parser = argparse.ArgumentParser(description='Check evaluation documentation structure')
    parser.add_argument('--files', nargs='+', required=True, help='Files to check')
    args = parser.parse_args()
    
    all_ok = True
    errors = []
    
    for filepath_str in args.files:
        filepath = Path(filepath_str)
        ok, file_errors = check_file(filepath)
        
        if not ok:
            all_ok = False
            errors.extend(file_errors)
        else:
            print(f"OK {filepath.name}: All required headings present")
    
    if not all_ok:
        print("\nERRORS found:")
        for error in errors:
            print(f"  {error}")
        sys.exit(1)
    
    print("\nOK All evaluation documentation files are valid")
    sys.exit(0)

if __name__ == '__main__':
    main()
