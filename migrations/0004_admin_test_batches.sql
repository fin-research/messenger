CREATE TABLE admin_test_batches (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  request TEXT NOT NULL,
  deliveries TEXT NOT NULL,
  skipped TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX admin_test_batches_pending ON admin_test_batches(completed_at, created_at);
