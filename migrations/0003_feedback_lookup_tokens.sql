-- Apply after the existing feedback and feedback_tracking tables are present.
-- Store only a SHA-256 digest of each 256-bit lookup capability.
CREATE TABLE IF NOT EXISTS feedback_lookup_tokens (
  feedback_id TEXT PRIMARY KEY REFERENCES feedback(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL
);
