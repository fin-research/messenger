CREATE TABLE workflow_events (
 id TEXT PRIMARY KEY,
 event TEXT NOT NULL,
 messages TEXT,
 created_at INTEGER NOT NULL,
 next_attempt_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 completed_at INTEGER
);
CREATE INDEX workflow_events_due ON workflow_events(completed_at,next_attempt_at);
