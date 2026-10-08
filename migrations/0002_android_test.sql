-- Apply after 0001. This only adds Android tables; existing iOS rows and IDs are untouched.
CREATE TABLE IF NOT EXISTS android_feedback (
  report_number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved','closed')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT,
  app_version TEXT,
  build_number TEXT,
  android_version TEXT,
  device_model TEXT,
  diagnostics_json TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  public_title TEXT,
  public_note TEXT,
  fixed_version TEXT,
  fixed_build TEXT,
  eta_seconds INTEGER,
  eta_due_at TEXT,
  fix_published INTEGER NOT NULL DEFAULT 0 CHECK (fix_published IN (0,1)),
  unable_reason TEXT,
  deleted_at TEXT,
  deletion_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_android_feedback_public ON android_feedback(is_public, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_android_feedback_created ON android_feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS android_release (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version TEXT NOT NULL,
  build_number TEXT NOT NULL,
  released_at TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signing_fingerprint TEXT NOT NULL,
  notes TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1))
);
CREATE TABLE IF NOT EXISTS android_release_history (
  version TEXT NOT NULL,
  build_number TEXT NOT NULL,
  released_at TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (version, build_number)
);
CREATE TABLE IF NOT EXISTS android_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_version TEXT NOT NULL,
  downloaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_android_downloads_time ON android_downloads(downloaded_at);

-- One row per random app-generated installation ID, stored only as an HMAC digest.
CREATE TABLE IF NOT EXISTS android_installations (
  install_hash TEXT PRIMARY KEY,
  first_open_at TEXT NOT NULL,
  last_open_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_android_installations_active ON android_installations(last_open_at);
-- Ephemeral per-day anonymous rate counters; remove old rows during maintenance.
CREATE TABLE IF NOT EXISTS android_rate_limits (
  key_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
