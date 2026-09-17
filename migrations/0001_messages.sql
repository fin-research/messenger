CREATE TABLE messages (
 id TEXT PRIMARY KEY,
 source TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 payload TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('email','telegram')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retrying','accepted','failed','uncertain')),
 attempts INTEGER NOT NULL DEFAULT 0,
 cycle_attempts INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0,
 provider_id TEXT,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 next_attempt_at INTEGER NOT NULL,
 first_attempt_at INTEGER,
 lease_until INTEGER,
 lease_token TEXT,
 UNIQUE(source,idempotency_key)
);
CREATE INDEX messages_due ON messages(status,next_attempt_at);
CREATE INDEX messages_recent ON messages(created_at DESC,id DESC);
CREATE TABLE attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES messages(id),
 number INTEGER NOT NULL,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 status TEXT NOT NULL,
 provider_id TEXT,
 error TEXT,
 UNIQUE(message_id,number)
);
CREATE TABLE retry_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES messages(id),
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 previous_status TEXT NOT NULL
);
