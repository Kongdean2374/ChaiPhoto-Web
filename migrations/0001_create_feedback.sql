CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT,
  app_version TEXT,
  build_number TEXT,
  ios_version TEXT,
  device_model TEXT,
  source TEXT NOT NULL DEFAULT 'web'
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at
  ON feedback(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created_at
  ON feedback(status, created_at DESC);
