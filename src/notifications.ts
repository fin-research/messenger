import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { messageSchema, pushSubscriptionSchema, type Bindings, type MessageInput } from './contracts';
import { enqueue } from './service';

export const categories = ['workflow','trading','financing'] as const;
export const channels = ['email','telegram','webpush'] as const;
export const settingsSchema = z.object({
 email: z.union([z.email().max(254), z.literal('')]),
 telegramChatId: z.union([z.string().regex(/^-?\d{1,20}$/),z.literal('')]),
 subscriptions: z.object({ workflow: z.array(z.enum(channels)).max(3), trading: z.array(z.enum(channels)).max(3), financing: z.array(z.enum(channels)).max(3) }).strict(),
}).strict();
export const notificationSchema = z.object({
 source: z.string().regex(/^[a-z0-9-]{1,64}$/), idempotencyKey: z.string().min(1).max(240),
 category: z.enum(categories), title: z.string().min(1).max(500), text: z.string().min(1).max(100_000),
 url: z.string().max(2048).refine(v => v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')),
 userIds: z.array(z.string().regex(/^auth0\|[^\s]{1,249}$/)).max(500).optional(),
}).strict();
type Notification = z.infer<typeof notificationSchema>;
type SettingsRow = {user_id:string; email:string; telegram_chat_id:string; subscriptions:string};
export async function settings(env:Bindings,userId:string) {
 const row = await env.DB.prepare('SELECT * FROM notification_settings WHERE user_id=?').bind(userId).first<SettingsRow>();
 const devices = await env.DB.prepare('SELECT id,created_at AS createdAt FROM push_subscriptions WHERE user_id=? ORDER BY created_at').bind(userId).all();
 return { email: row?.email ?? '', telegramChatId: row?.telegram_chat_id ?? '',
   subscriptions: row ? JSON.parse(row.subscriptions) : {workflow:[],trading:[],financing:[]}, devices:devices.results,
   vapidPublicKey:env.VAPID_PUBLIC_KEY ?? '' };
}
export async function saveSettings(env:Bindings,userId:string,raw:unknown) {
 const parsed=settingsSchema.safeParse(raw);
 if(!parsed.success) throw new HTTPException(422,{message:'INVALID_SETTINGS'});
 const value=parsed.data;
 if(Object.values(value.subscriptions).some(c=>c.includes('email'))&&!value.email) throw new HTTPException(422,{message:'EMAIL_REQUIRED'});
 if(Object.values(value.subscriptions).some(c=>c.includes('telegram'))&&!value.telegramChatId) throw new HTTPException(422,{message:'TELEGRAM_REQUIRED'});
 await env.DB.prepare(`INSERT INTO notification_settings(user_id,email,telegram_chat_id,subscriptions,updated_at) VALUES(?,?,?,?,?)
 ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,telegram_chat_id=excluded.telegram_chat_id,subscriptions=excluded.subscriptions,updated_at=excluded.updated_at`)
 .bind(userId,value.email,value.telegramChatId,JSON.stringify(value.subscriptions),Date.now()).run();
 return settings(env,userId);
}
export async function savePush(env:Bindings,userId:string,raw:unknown) {
 const parsed=pushSubscriptionSchema.safeParse(raw);
 if(!parsed.success) throw new HTTPException(422,{message:'INVALID_PUSH_SUBSCRIPTION'});
 const value=parsed.data;
 // A capability endpoint cannot be moved to another account by supplying its URL.
 const old=await env.DB.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint=?').bind(value.endpoint).first<{user_id:string}>();
 const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').bind(userId).first<{count:number}>();
 if(!old && (count?.count ?? 0)>=10)throw new HTTPException(422,{message:'PUSH_DEVICE_LIMIT'});
 if(old && old.user_id!==userId) throw new HTTPException(409,{message:'PUSH_OWNED_BY_ANOTHER_ACCOUNT'});
 await env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,subscription,created_at) VALUES(?,?,?,?,?)
 ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription WHERE user_id=excluded.user_id`)
 .bind(crypto.randomUUID(),userId,value.endpoint,JSON.stringify(value),Date.now()).run();
 const device=await env.DB.prepare('SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=?').bind(userId,value.endpoint).first<{id:string}>();
 return {...await settings(env,userId),deviceId:device!.id};
}
async function publish(env:Bindings,id:string) {
 try { await env.QUEUE.send({id,kind:'notification'}); } catch { console.warn('notification_publish_deferred'); }
}
export async function notify(env:Bindings,raw:unknown) {
 const parsed=notificationSchema.safeParse(raw);
 if(!parsed.success) throw new HTTPException(422,{message:'INVALID_NOTIFICATION'});
 const value=parsed.data,payload=JSON.stringify(value),now=Date.now();
 await env.DB.prepare(`INSERT INTO notifications(id,source,idempotency_key,payload,created_at,next_attempt_at) VALUES(?,?,?,?,?,?)
 ON CONFLICT(source,idempotency_key) DO NOTHING`).bind(crypto.randomUUID(),value.source,value.idempotencyKey,payload,now,now).run();
 const row=await env.DB.prepare('SELECT id,payload FROM notifications WHERE source=? AND idempotency_key=?').bind(value.source,value.idempotencyKey).first<{id:string;payload:string}>();
 if(!row) throw new Error('NOTIFICATION_PERSIST_FAILED');
 if(row.payload!==payload) throw new HTTPException(409,{message:'IDEMPOTENCY_CONFLICT'});
 await publish(env,row.id);
 return {id:row.id,status:'queued'};
}
export async function eligibleUsers(env:Bindings):Promise<{id:string;categories:string[]}[]> {
 if(!env.NOTIFICATION_SOURCE) throw new Error('NOTIFICATION_SOURCE_UNAVAILABLE');
 const response=await env.NOTIFICATION_SOURCE.fetch('https://notifications.internal/eligible');
 if(!response.ok) throw new Error('NOTIFICATION_ELIGIBILITY_UNAVAILABLE');
 return z.array(z.object({id:z.string(),categories:z.array(z.enum(categories))})).parse(await response.json());
}
async function deliveries(env:Bindings,id:string,event:Notification):Promise<MessageInput[]> {
 const eligible=new Set((await eligibleUsers(env)).filter(u=>u.categories.includes(event.category)&&(!event.userIds||event.userIds.includes(u.id))).map(u=>u.id));
 const rows=await env.DB.prepare('SELECT * FROM notification_settings').all<SettingsRow>();
 const result:MessageInput[]=[];
 for(const row of rows.results) {
  if(!eligible.has(row.user_id)) continue;
  const selected:string[]=JSON.parse(row.subscriptions)[event.category] ?? [];
  const common={notification:{userId:row.user_id,category:event.category},source:'notification',idempotencyKey:`${id}/${row.user_id}`};
  const text=`${event.text}\n\nhttps://eastmoney.hasbai.xyz${event.url}`;
  if(selected.includes('email')&&row.email)result.push(messageSchema.parse({...common,idempotencyKey:common.idempotencyKey+'/email',channel:'email',to:[row.email],subject:event.title,text}));
  if(selected.includes('telegram')&&row.telegram_chat_id){
   const chars=Array.from(`${event.title}\n${text}`);
   for(let i=0;i<chars.length;i+=1800) result.push(messageSchema.parse({...common,idempotencyKey:common.idempotencyKey+`/telegram/${i}`,channel:'telegram',chatId:row.telegram_chat_id,text:chars.slice(i,i+1800).join('')}));
  }
  if(selected.includes('webpush')){
   const devices=await env.DB.prepare('SELECT id,subscription FROM push_subscriptions WHERE user_id=?').bind(row.user_id).all<{id:string;subscription:string}>();
   for(const device of devices.results)result.push(messageSchema.parse({...common,idempotencyKey:`${id}/${device.id}`,channel:'webpush',userId:row.user_id,subscriptionId:device.id,subscription:JSON.parse(device.subscription),title:event.title,text:event.text.slice(0,400),url:event.url,tag:id}));
  }
 }
 return result;
}
export async function processNotification(env:Bindings,id:string) {
 const row=await env.DB.prepare('SELECT * FROM notifications WHERE id=?').bind(id).first<{payload:string;deliveries:string|null;completed_at:number|null;attempts:number}>();
 if(!row||row.completed_at!==null)return;
 try {
  if(!row.deliveries){const items=await deliveries(env,id,notificationSchema.parse(JSON.parse(row.payload)));
   await env.DB.prepare('UPDATE notifications SET deliveries=? WHERE id=? AND deliveries IS NULL').bind(JSON.stringify(items),id).run();}
  const snapshot=await env.DB.prepare('SELECT deliveries FROM notifications WHERE id=?').bind(id).first<{deliveries:string}>();
  for(const item of z.array(messageSchema).parse(JSON.parse(snapshot!.deliveries)))await enqueue(env,item);
  await env.DB.prepare('UPDATE notifications SET completed_at=?,last_error=NULL WHERE id=? AND completed_at IS NULL').bind(Date.now(),id).run();
 }catch{
  await env.DB.prepare(`UPDATE notifications SET attempts=attempts+1,next_attempt_at=?,last_error='NOTIFICATION_DEFERRED' WHERE id=? AND completed_at IS NULL`)
   .bind(Date.now()+Math.min(3600_000,30000*2**Math.min(row.attempts,7)),id).run();
 }
}
export async function recoverNotifications(env:Bindings,now=Date.now()) {
 const rows=await env.DB.prepare('SELECT id FROM notifications WHERE completed_at IS NULL AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 50').bind(now).all<{id:string}>();
 for(const row of rows.results)await publish(env,row.id);
}
export async function scanNotifications(env:Bindings,now:number) {
 if(!env.NOTIFICATION_SOURCE)return;
 const slot=Math.floor(now/60000);
 await env.DB.prepare("INSERT OR IGNORE INTO notification_schedule(id) VALUES('dashboard')").run();
 const claim=await env.DB.prepare("UPDATE notification_schedule SET lease_until=? WHERE id='dashboard' AND completed_slot<? AND lease_until<? RETURNING id").bind(now+55000,slot,now).first();
 if(!claim)return;
 const response=await env.NOTIFICATION_SOURCE.fetch('https://notifications.internal/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduledTime:slot*60000})});
 if(!response.ok)throw new Error('NOTIFICATION_SCAN_FAILED');
 await env.DB.prepare("UPDATE notification_schedule SET completed_slot=?,lease_until=0 WHERE id='dashboard' AND lease_until=?").bind(slot,now+55000).run();
}

/** One-time additive migration: keep the existing operator channels until they edit settings. */
export async function migrateLegacyWorkflowSubscriber(env:Bindings) {
 const userId=env.LEGACY_WORKFLOW_USER_ID;
 if(!userId)return;
 if(await env.DB.prepare('SELECT user_id FROM notification_settings WHERE user_id=?').bind(userId).first())return;
 const chatId=await env.TELEGRAM_USER_ID.get();
 const value=settingsSchema.parse({email:env.WORKFLOW_NOTIFICATION_EMAILS,telegramChatId:chatId,subscriptions:{workflow:['email','telegram'],trading:[],financing:[]}});
 await env.DB.prepare(`INSERT INTO notification_settings(user_id,email,telegram_chat_id,subscriptions,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING`)
 .bind(userId,value.email,value.telegramChatId,JSON.stringify(value.subscriptions),Date.now()).run();
}
