CREATE TABLE messages_new (
 id TEXT PRIMARY KEY,
 source TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 payload TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('email','telegram','webpush')),
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
CREATE INDEX messages_new_due ON messages_new(status,next_attempt_at);
CREATE INDEX messages_new_recent ON messages_new(created_at DESC,id DESC);
CREATE TABLE attempts_new (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES messages_new(id),
 number INTEGER NOT NULL,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 status TEXT NOT NULL,
 provider_id TEXT,
 error TEXT,
 UNIQUE(message_id,number)
);
CREATE TABLE retry_audit_new (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES messages_new(id),
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 previous_status TEXT NOT NULL
);

INSERT INTO messages_new SELECT * FROM messages;
INSERT INTO attempts_new SELECT * FROM attempts;
INSERT INTO retry_audit_new SELECT * FROM retry_audit;
DROP TABLE attempts;
DROP TABLE retry_audit;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE attempts_new RENAME TO attempts;
ALTER TABLE retry_audit_new RENAME TO retry_audit;

CREATE TABLE notification_settings (
 user_id TEXT PRIMARY KEY, email TEXT NOT NULL DEFAULT '', telegram_chat_id TEXT NOT NULL DEFAULT '',
 subscriptions TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE TABLE push_subscriptions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, subscription TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX push_owner ON push_subscriptions(user_id);
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL,
 deliveries TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT,
 UNIQUE(source,idempotency_key)
);
CREATE INDEX notifications_due ON notifications(completed_at,next_attempt_at);
CREATE TABLE notification_schedule (
 id TEXT PRIMARY KEY, completed_slot INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
);
