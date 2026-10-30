PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK(length(title) <= 160),
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  added_at TEXT NOT NULL,
  updated_at TEXT,
  removed_at TEXT,
  removed_by TEXT,
  PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS trip_members_by_user ON trip_members(user_id, removed_at, trip_id);

CREATE TABLE IF NOT EXISTS trip_state (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_state_history (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (trip_id, revision)
);
CREATE INDEX IF NOT EXISTS trip_state_history_recent ON trip_state_history(trip_id, revision DESC);

CREATE TABLE IF NOT EXISTS trip_invitations (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','expired','revoked')),
  inviter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT,
  revoked_by TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS trip_invitations_by_trip ON trip_invitations(trip_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS trip_attachments (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  transport_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 26214400),
  object_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  PRIMARY KEY (trip_id, id)
);
CREATE INDEX IF NOT EXISTS trip_attachments_by_trip_transport ON trip_attachments(trip_id, transport_id, deleted_at);
