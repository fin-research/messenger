import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { messageSchema, type Bindings, type MessageInput } from './contracts';
import { enqueue } from './service';

const channelSchema = z.enum(['email', 'telegram', 'webpush']);
export const testMessageSchema = z.object({
  requestId: z.string().uuid(), actor: z.string().regex(/^auth0\|[^\s]{1,249}$/),
  userIds: z.array(z.string().regex(/^auth0\|[^\s]{1,249}$/)).min(1).max(50),
  channels: z.array(channelSchema).min(1).max(3),
  title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(1000),
}).strict();
type Batch = { id: string; actor: string; request: string; deliveries: string; skipped: string; cursor: number; completed_at: number | null };
type Skipped = {userId: string; channel: z.infer<typeof channelSchema>; reason: string};

/** Only Dashboard's admin action calls this private entrypoint; actor is audit data. */
export async function sendTestMessages(env: Bindings, raw: unknown) {
  const parsed = testMessageSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(422, {message: 'INVALID_TEST_MESSAGE'});
  const value = {...parsed.data, userIds: [...new Set(parsed.data.userIds)].sort(), channels: [...new Set(parsed.data.channels)].sort()};
  const request = JSON.stringify(value);
  let batch = await env.DB.prepare('SELECT * FROM admin_test_batches WHERE id=?').bind(value.requestId).first<Batch>();
  if (!batch) {
    const deliveries: MessageInput[] = [], skipped: Skipped[] = [];
    for (const userId of value.userIds) {
      const contact = await env.DB.prepare('SELECT email,telegram_chat_id FROM notification_settings WHERE user_id=?').bind(userId).first<{email:string;telegram_chat_id:string}>();
      for (const channel of value.channels) {
        const common = {source:'admin-test', adminTest:{userId, actor:value.actor}, idempotencyKey:`${value.requestId}/${value.userIds.indexOf(userId)}/${channel}`};
        if (channel === 'email' && contact?.email) {
          deliveries.push(messageSchema.parse({...common,channel,to:[contact.email],subject:value.title,text:value.text}));
        } else if (channel === 'telegram' && contact?.telegram_chat_id) {
          deliveries.push(messageSchema.parse({...common,channel,chatId:contact.telegram_chat_id,text:`${value.title}\n${value.text}`}));
        } else if (channel === 'webpush') {
          const devices = await env.DB.prepare('SELECT id,subscription FROM push_subscriptions WHERE user_id=? ORDER BY id').bind(userId).all<{id:string;subscription:string}>();
          for (const device of devices.results) deliveries.push(messageSchema.parse({...common,channel,idempotencyKey:`${value.requestId}/${device.id}`,userId,subscriptionId:device.id,subscription:JSON.parse(device.subscription),title:value.title,text:value.text,url:'/management/notifications',tag:value.requestId}));
          if (!devices.results.length) skipped.push({userId,channel,reason:'未启用设备'});
        } else skipped.push({userId,channel,reason:channel === 'email' ? '未配置联系邮箱' : '未配置 Telegram'});
      }
    }
    // Freeze all recipients before enqueueing so retries cannot move to a new contact.
    await env.DB.prepare('INSERT INTO admin_test_batches(id,actor,request,deliveries,skipped,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(value.requestId,value.actor,request,JSON.stringify(deliveries),JSON.stringify(skipped),Date.now()).run();
    batch = await env.DB.prepare('SELECT * FROM admin_test_batches WHERE id=?').bind(value.requestId).first<Batch>();
  }
  if (!batch || batch.request !== request) throw new HTTPException(409,{message:'IDEMPOTENCY_CONFLICT'});
  // The durable batch is accepted even if immediate fan-out is interrupted.
  try { await processTestBatch(env,batch); } catch { console.warn('admin_test_batch_deferred'); }
  return {id:batch.id,status:'queued',deliveries:JSON.parse(batch.deliveries).length,skipped:JSON.parse(batch.skipped) as Skipped[]};
}
async function processTestBatch(env: Bindings, batch: Batch) {
  if (batch.completed_at !== null) return;
  const items = z.array(messageSchema).parse(JSON.parse(batch.deliveries));
  const end = Math.min(items.length,batch.cursor + 25);
  for (let index=batch.cursor; index<end; index++) await enqueue(env,items[index]);
  await env.DB.prepare('UPDATE admin_test_batches SET cursor=?,completed_at=? WHERE id=? AND cursor=? AND completed_at IS NULL')
    .bind(end,end === items.length ? Date.now() : null,batch.id,batch.cursor).run();
}
export async function recoverTestBatches(env: Bindings) {
  const batches = await env.DB.prepare('SELECT * FROM admin_test_batches WHERE completed_at IS NULL ORDER BY created_at LIMIT 5').all<Batch>();
  for (const batch of batches.results) { try { await processTestBatch(env,batch); } catch { console.warn('admin_test_batch_deferred'); } }
}
