import {env} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import webpush from 'web-push';
import initial from '../migrations/0001_messages.sql?raw';
import migration from '../migrations/0003_user_notifications.sql?raw';
import {notify,processNotification,saveSettings,savePush,settings} from '../src/notifications';
import {deliver} from '../src/providers';
import type {Bindings} from '../src/contracts';
const db=(env as unknown as Bindings).DB;
const source={fetch:vi.fn(async()=>Response.json([{id:'auth0|test',categories:['trading','financing']}]))};
const bindings={DB:db,QUEUE:{send:vi.fn(async()=>{})},NOTIFICATION_SOURCE:source} as unknown as Bindings;
const event={source:'trading',category:'trading',idempotencyKey:'day/node/time',title:'交易流程',text:'完成划款',url:'/trading-research/workflow'};
const configured={email:'contact@example.com',telegramChatId:'123',subscriptions:{workflow:[],trading:['email','telegram'],financing:[]}};
beforeAll(async()=>{await db.batch((initial+'\n'+migration).split(';').map(s=>s.trim()).filter(Boolean).map(sql=>db.prepare(sql)));});
beforeEach(async()=>{
 await db.batch(['retry_audit','attempts','messages','notifications','push_subscriptions','notification_settings'].map(table=>db.prepare(`DELETE FROM ${table}`)));
 source.fetch.mockResolvedValue(Response.json([{id:'auth0|test',categories:['trading','financing']}]));
 source.fetch.mockImplementation(async()=>Response.json([{id:'auth0|test',categories:['trading','financing']}]));
 await saveSettings(bindings,'auth0|test',configured);
});
it('generation persists independently, subscriptions fan out exactly once with contact email',async()=>{
 const first=await notify(bindings,event);const duplicate=await notify(bindings,event);expect(first.id).toBe(duplicate.id);
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(0);
 await Promise.all([processNotification(bindings,first.id),processNotification(bindings,first.id)]);
 const rows=(await db.prepare('SELECT payload FROM messages').all<{payload:string}>()).results.map(row=>JSON.parse(row.payload));
 expect(rows).toHaveLength(2);expect(rows.find(row=>row.channel==='email').to).toEqual(['contact@example.com']);
 await expect(notify(bindings,{...event,text:'changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
it('recipient scope and current authorization limit subscriptions',async()=>{
 for(const [id,extra] of [['unrelated',{userIds:['auth0|other']}],['admin',{category:'workflow'}]]){
  const row=await notify(bindings,{...event,idempotencyKey:id,...extra});await processNotification(bindings,row.id);
 }
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(0);
});
it('rechecks unsubscribe, contact changes, and revoked authorization before delayed delivery',async()=>{
 const row=await notify(bindings,event);await processNotification(bindings,row.id);
 const payload=JSON.parse((await db.prepare("SELECT payload FROM messages WHERE channel='email'").first<{payload:string}>())!.payload);
 await saveSettings(bindings,'auth0|test',{...configured,subscriptions:{workflow:[],trading:[],financing:[]}});
 await expect(deliver(bindings,payload,'test')).rejects.toThrow('NOTIFICATION_UNSUBSCRIBED');
 await saveSettings(bindings,'auth0|test',{...configured,email:'changed@example.com'});
 await expect(deliver(bindings,payload,'test')).rejects.toThrow('NOTIFICATION_CONTACT_CHANGED');
 await saveSettings(bindings,'auth0|test',configured);source.fetch.mockImplementation(async()=>Response.json([]));
 await expect(deliver(bindings,payload,'test')).rejects.toThrow('NOTIFICATION_ACCESS_REVOKED');
});
it('push credentials are owner-scoped, encrypted, and removed after provider expiry',async()=>{
 const keys=webpush.generateVAPIDKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:keys.publicKey,auth:Buffer.alloc(16,1).toString('base64url')}};
 const state=await savePush(bindings,'auth0|test',subscription);const id=(state.devices[0] as {id:string}).id;
 expect(JSON.stringify(await settings(bindings,'auth0|other'))).not.toContain(id);
 await expect(savePush(bindings,'auth0|other',subscription)).rejects.toThrow('PUSH_OWNED_BY_ANOTHER_ACCOUNT');
 await expect(savePush(bindings,'auth0|test',{...subscription,endpoint:'https://internal.invalid/secret'})).rejects.toThrow('INVALID_PUSH_SUBSCRIPTION');
 const pushEnv={...bindings,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
 const outgoing=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
  expect(options?.headers).toHaveProperty('Content-Encoding','aes128gcm');expect(options?.redirect).toBe('error');
  expect(new TextDecoder().decode(options!.body as Uint8Array)).not.toContain('private text');return new Response(null,{status:410});
 });
 try{await expect(deliver(pushEnv,{source:'test',idempotencyKey:'push',channel:'webpush',userId:'auth0|test',subscriptionId:id,subscription,title:'提醒',text:'private text',url:'/',tag:'test'},'test')).rejects.toThrow('PUSH_EXPIRED');}
 finally{outgoing.mockRestore();}
 expect((await settings(bindings,'auth0|test')).devices).toHaveLength(0);
});
