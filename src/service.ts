import { HTTPException } from 'hono/http-exception';
import { messageSchema, type Bindings, type MessageInput, type MessageRow } from './contracts';
import { deliver, DeliveryError } from './providers';

const MAX_ATTEMPTS = 6;
const LEASE_MS = 120_000;
const EMAIL_SAFE_WINDOW_MS = 23 * 3600_000;
export async function getMessage(env: Bindings, id: string) {
  return env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first<MessageRow>();
}
export function dto(row: MessageRow) {
  const input = messageSchema.parse(JSON.parse(row.payload));
  return { id: row.id, source: row.source, channel: row.channel, status: row.status,
    subject: input.channel === 'email' ? input.subject : input.text.slice(0,120),
    recipient: input.channel === 'email' ? input.to.join(', ') : input.chatId ?? '默认 Telegram',
    attempts: row.attempts, providerId: row.provider_id, error: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at, nextAttemptAt: row.next_attempt_at };
}
export async function enqueue(env: Bindings, raw: unknown) {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(422, { message: 'INVALID_MESSAGE' });
  const input = parsed.data;
  const now = Date.now(), id = crypto.randomUUID(), payload = JSON.stringify(input);
  await env.DB.prepare(`INSERT INTO messages(id,source,idempotency_key,payload,channel,created_at,updated_at,next_attempt_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,idempotency_key) DO NOTHING`)
    .bind(id,input.source,input.idempotencyKey,payload,input.channel,now,now,now).run();
  const row = await env.DB.prepare('SELECT * FROM messages WHERE source=? AND idempotency_key=?')
    .bind(input.source,input.idempotencyKey).first<MessageRow>();
  if (!row) throw new Error('MESSAGE_PERSIST_FAILED');
  if (row.payload !== payload) throw new HTTPException(409, { message: 'IDEMPOTENCY_CONFLICT' });
  if (row.status === 'queued' || row.status === 'retrying') await publish(env, row.id);
  return dto(row);
}
async function publish(env: Bindings, id: string) {
  // Durable outbox: a failed Queue publish must not erase an accepted D1 submission.
  try { await env.QUEUE.send({ id }); } catch { console.warn('messenger_queue_publish_deferred'); }
}

export async function processMessage(env: Bindings, id: string, send = deliver, now = Date.now()) {
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE messages SET status='processing', lease_token=?, lease_until=?,
    attempts=attempts+1, cycle_attempts=cycle_attempts+1, first_attempt_at=COALESCE(first_attempt_at,?), updated_at=?
    WHERE id=? AND status IN ('queued','retrying') AND next_attempt_at<=? RETURNING *`)
    .bind(token, now+LEASE_MS, now, now, id, now).first<MessageRow>();
  if (!row) return;
  await env.DB.prepare(`INSERT INTO attempts(message_id,number,started_at,status) VALUES(?,?,?,'processing')`)
    .bind(id,row.attempts,now).run();
  let status: MessageRow['status'] = 'accepted', provider: string|null = null, errorCode: string|null = null, delay = 0;
  try {
    if (row.channel === 'email' && now - (row.first_attempt_at ?? now) >= EMAIL_SAFE_WINDOW_MS) {
      throw new DeliveryError('EMAIL_IDEMPOTENCY_WINDOW_EXPIRED', false, true);
    }
    provider = await send(env, messageSchema.parse(JSON.parse(row.payload)), `messenger/${id}/${row.generation}`);
  } catch (error) {
    const failure = error instanceof DeliveryError ? error : new DeliveryError('DELIVERY_RESULT_UNKNOWN', false, true);
    errorCode = failure.code;
    status = failure.uncertain && row.channel === 'telegram' ? 'uncertain'
      : failure.retryable && row.cycle_attempts < MAX_ATTEMPTS ? 'retrying'
      : failure.uncertain ? 'uncertain' : 'failed';
    delay = Math.max(failure.retryAfter * 1000, Math.min(3600_000, 30_000 * 2 ** (row.cycle_attempts-1)));
  }
  const finished = Date.now();
  const completed = await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET status=?,provider_id=?,last_error=?,updated_at=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL
      WHERE id=? AND lease_token=?`).bind(status,provider,errorCode,finished,finished+delay,id,token),
    env.DB.prepare(`UPDATE attempts SET status=?,provider_id=?,error=?,finished_at=? WHERE message_id=? AND number=? AND status='processing'`)
      .bind(status,provider,errorCode,finished,id,row.attempts),
  ]);
  if (status === 'retrying' && completed[0].meta.changes === 1) {
    try { await env.QUEUE.send({ id }, { delaySeconds: Math.ceil(delay/1000) }); }
    catch { console.warn('messenger_retry_publish_deferred'); }
  }
}

export async function recover(env: Bindings, now = Date.now()) {
  // An interrupted send may have reached the provider. Telegram cannot be safely replayed.
  const stale = await env.DB.prepare(`SELECT * FROM messages WHERE status='processing' AND lease_until<? LIMIT 100`).bind(now).all<MessageRow>();
  for (const row of stale.results) {
    const status = row.channel === 'email' && row.cycle_attempts < MAX_ATTEMPTS && now-(row.first_attempt_at ?? 0)<EMAIL_SAFE_WINDOW_MS ? 'retrying' : 'uncertain';
    await env.DB.batch([
      env.DB.prepare(`UPDATE messages SET status=?,last_error='WORKER_INTERRUPTED',updated_at=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL
        WHERE id=? AND status='processing' AND lease_token=?`).bind(status,now,now,row.id,row.lease_token),
      env.DB.prepare(`UPDATE attempts SET status=?,error='WORKER_INTERRUPTED',finished_at=? WHERE message_id=? AND number=? AND status='processing'`)
        .bind(status,now,row.id,row.attempts),
    ]);
  }
  const due = await env.DB.prepare(`SELECT id FROM messages WHERE status IN ('queued','retrying') AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 100`).bind(now).all<{id:string}>();
  for (const row of due.results) await publish(env,row.id);
}

export async function retryMessage(env: Bindings, id: string, actor: string, confirmUncertain: boolean) {
  const row = await getMessage(env,id);
  if (!row) throw new HTTPException(404,{message:'NOT_FOUND'});
  if (!['failed','uncertain'].includes(row.status)) throw new HTTPException(409,{message:'NOT_RETRYABLE'});
  if (row.status==='uncertain' && !confirmUncertain) throw new HTTPException(409,{message:'CONFIRM_UNCERTAIN_REQUIRED'});
  const now=Date.now();
  // Audit and transition are atomic. A competing retry cannot create a second generation.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO retry_audit(message_id,actor,created_at,previous_status)
      SELECT id,?,?,status FROM messages WHERE id=? AND status=? AND generation=?`).bind(actor,now,id,row.status,row.generation),
    env.DB.prepare(`UPDATE messages SET status='queued',cycle_attempts=0,generation=generation+1,first_attempt_at=NULL,
      last_error=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND status=? AND generation=?`).bind(now,now,id,row.status,row.generation),
  ]);
  if (!results[1].meta.changes) throw new HTTPException(409,{message:'RETRY_CONFLICT'});
  await publish(env,id);
  return dto((await getMessage(env,id))!);
}
