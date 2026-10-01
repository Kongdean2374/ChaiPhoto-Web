-- ChaiPhoto feedback tracking v2
-- Adds stable public report numbers, ETA, diagnostics and tombstone deletion metadata.

ALTER TABLE feedback ADD COLUMN report_number INTEGER;
ALTER TABLE feedback ADD COLUMN eta_seconds INTEGER;
ALTER TABLE feedback ADD COLUMN eta_due_at TEXT;
ALTER TABLE feedback ADD COLUMN fix_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback ADD COLUMN unable_reason TEXT;
ALTER TABLE feedback ADD COLUMN diagnostics_json TEXT;
ALTER TABLE feedback ADD COLUMN deleted_at TEXT;
ALTER TABLE feedback ADD COLUMN deletion_reason TEXT;

-- Backfill existing reports in deterministic creation order.
UPDATE feedback AS current
SET report_number = (
  SELECT COUNT(*)
  FROM feedback AS older
  WHERE older.created_at < current.created_at
     OR (older.created_at = current.created_at AND older.id <= current.id)
)
WHERE report_number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_report_number
  ON feedback(report_number);

CREATE INDEX IF NOT EXISTS idx_feedback_version
  ON feedback(app_version);

CREATE INDEX IF NOT EXISTS idx_feedback_build
  ON feedback(build_number);

CREATE INDEX IF NOT EXISTS idx_feedback_ios
  ON feedback(ios_version);

CREATE TABLE IF NOT EXISTS feedback_counter (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_number INTEGER NOT NULL CHECK (next_number >= 1)
);

INSERT OR IGNORE INTO feedback_counter (singleton, next_number)
VALUES (1, 1);

UPDATE feedback_counter
SET next_number = (
  SELECT COALESCE(MAX(report_number), 0) + 1
  FROM feedback
)
WHERE singleton = 1;
