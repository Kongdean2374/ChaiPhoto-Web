-- Feedback V2 companion schema.
-- This migration is additive: existing feedback rows and BETA IDs stay untouched.

CREATE TABLE IF NOT EXISTS feedback_v2_meta (
  feedback_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL
    CHECK (source_key IN ('beta', 'tf')),
  source_number INTEGER NOT NULL
    CHECK (source_number >= 1),
  original_description TEXT,
  original_steps TEXT,
  edited_description TEXT,
  edited_steps TEXT,
  description_state TEXT NOT NULL DEFAULT 'provided'
    CHECK (description_state IN ('provided', 'missing', 'not_applicable')),
  steps_state TEXT NOT NULL DEFAULT 'missing'
    CHECK (steps_state IN ('provided', 'missing', 'not_applicable')),
  external_resource_id TEXT,
  external_event_type TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_key, source_number),
  UNIQUE (source_key, external_resource_id),
  FOREIGN KEY (feedback_id) REFERENCES feedback(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_v2_source_number
  ON feedback_v2_meta(source_key, source_number);

CREATE INDEX IF NOT EXISTS idx_feedback_v2_external_resource
  ON feedback_v2_meta(external_resource_id);

CREATE TABLE IF NOT EXISTS feedback_source_counter (
  source_key TEXT PRIMARY KEY
    CHECK (source_key IN ('beta', 'tf')),
  next_number INTEGER NOT NULL
    CHECK (next_number >= 1)
);

INSERT OR IGNORE INTO feedback_source_counter (source_key, next_number)
VALUES ('beta', 1);

INSERT OR IGNORE INTO feedback_source_counter (source_key, next_number)
VALUES ('tf', 1);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('web', 'testflight')),
  storage_key TEXT,
  mime_type TEXT,
  original_filename TEXT,
  byte_size INTEGER,
  is_public INTEGER NOT NULL DEFAULT 0
    CHECK (is_public IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_feedback
  ON feedback_attachments(feedback_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_ingest_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT,
  resource_id TEXT,
  feedback_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  payload_json TEXT,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_ingest_resource
  ON feedback_ingest_events(provider, resource_id);
