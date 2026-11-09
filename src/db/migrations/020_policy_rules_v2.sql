-- Migration 020: policy_rules gains tool/target/signature matching and enforcement; derived rows are marked.
-- Timestamp: 2026-11-08 (v0.6 redesign, spec §4.4, §10)
--
-- derived_at IS NULL  -> manual rule (preserved by derivePolicyRules)
-- derived_at NOT NULL -> rewritten from active policy memories at the end of every writer commit

ALTER TABLE policy_rules ADD COLUMN tool_pattern TEXT NOT NULL DEFAULT '*';
ALTER TABLE policy_rules ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'any' CHECK(target_kind IN ('command', 'path', 'url', 'any'));
ALTER TABLE policy_rules ADD COLUMN pattern_kind TEXT CHECK(pattern_kind IN ('cmd', 'glob', 'regex', 'substring'));
ALTER TABLE policy_rules ADD COLUMN arg_pattern TEXT;
ALTER TABLE policy_rules ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'advise' CHECK(enforcement IN ('advise', 'confirm', 'soft_deny', 'deny'));
ALTER TABLE policy_rules ADD COLUMN derived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_policy_rules_derived ON policy_rules(derived_at);

PRAGMA user_version = 20;
