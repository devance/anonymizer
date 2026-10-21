-- Single-user schema for the desktop app. The whole file is encrypted by
-- SQLCipher, so real values are stored as plain JSON here; they never leave
-- the machine. Files and extracted text live in the encrypted blob store and
-- are referenced by the *_key columns.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The user's own names, addresses, SIN… seeded into every new project.
CREATE TABLE profile_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  real TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'anonymized', 'external', 'restored')),
  parent_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  -- What anonymized files are called on export; never the real filename.
  out_name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  -- Blob ids: the upload, its extracted text, the working copy the engine
  -- edits (OCR'd scan, photo turned PDF, decrypted PDF), fields outside the
  -- page flow.
  file_key TEXT,
  text_key TEXT,
  work_key TEXT,
  work_mime TEXT,
  fields_key TEXT,
  status TEXT NOT NULL,
  error TEXT,
  -- Per-step results so a retried job doesn't redo finished steps.
  steps TEXT NOT NULL DEFAULT '{}',
  -- Reviewer decisions: entity ids and match offsets only.
  review TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX documents_project ON documents(project_id, created_at);
CREATE INDEX documents_parent ON documents(parent_id);
CREATE INDEX documents_status ON documents(status);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  -- {real, surfaces}
  real TEXT NOT NULL,
  -- valueKey(type, real) from @anon/core: the identity of a real value.
  real_key TEXT NOT NULL,
  norm_v INTEGER NOT NULL,
  fake TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  attrs TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Set once a document using this fake has been exported; from then on the fake can't silently change.
  frozen_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (project_id, type, norm_v, real_key)
);
CREATE INDEX entities_project ON entities(project_id);

-- Uniqueness of fakes. scope '' = across the whole database; a project id = within that project.
CREATE TABLE fake_claims (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, scope, key)
);
CREATE INDEX fake_claims_entity ON fake_claims(entity_id);

CREATE TABLE document_entities (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  hits INTEGER NOT NULL,
  PRIMARY KEY (document_id, entity_id)
);

-- App settings (JSON values): detection model, auto-lock delay…
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
