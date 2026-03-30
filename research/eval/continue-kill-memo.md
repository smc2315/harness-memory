# Continue/Kill Memo

## Decision

CONTINUE.

## Why

The current evidence is strong enough for the narrow MVP question. The markdown-only baseline records 6 important policy misses, while the memory-layer harness replay records 0 important misses on the same 12-scenario corpus and explicitly logs 5 warnings, 3 conflict markers, and 2 stale markers.

That matters because the wedge was never "better storage for project notes." The wedge was selective activation at lifecycle boundaries: before-model guidance, before-tool warnings, stale-memory suppression, unresolved conflict surfacing, and after-tool evidence capture. The implemented system now demonstrates each of those behaviors in a repeatable harness run.

Markdown-only still remains sufficient for static project context. If a team can live with manual recall and occasional rereading of a disciplined `CLAUDE.md`, they do not need this system. The memory layer becomes justified only when the cost of missing the right warning or the right stale/conflict signal at the right moment is high enough.

## What This Does Not Yet Prove

This is still harness-level evidence, not a live A/B benchmark with a real coding model completing all 12 scenarios end to end. The current result shows that the system surfaces the right information. It does not yet prove that every live model will consistently heed that information.

That limitation does not change the recommendation. It changes the next step. The right move is not to broaden the roadmap. The right move is to run a real side-by-side benchmark using the exact same corpus and compare live outputs against the baseline scorecard. If that benchmark fails, stop broadening immediately and reassess the wedge before adding more product scope.

## Final Recommendation

Continue, but only as a narrow coding-harness memory layer focused on trigger-aware policy surfacing, stale/conflict handling, and evidence capture; do not expand scope until a live benchmark confirms the harness replay advantage.
