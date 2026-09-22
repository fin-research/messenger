import {env} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import webpush from 'web-push';
import initial from '../migrations/0001_messages.sql?raw';
import migration from '../migrations/0003_user_notifications.sql?raw';
import {notify,processNotification,saveSettings,savePush,settings,migrateLegacyWorkflowSubscriber} from '../src/notifications';
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
it('eligibility queries include only subscribed target users and skip empty audiences',async()=>{
 source.fetch.mockClear();
 const row=await notify(bindings,{...event,userIds:['auth0|test']});await processNotification(bindings,row.id);
 expect(source.fetch).toHaveBeenCalledOnce();
 const query=new URL(String(vi.mocked(source.fetch).mock.calls[0][0]));
 expect(query.searchParams.getAll('userId')).toEqual(['auth0|test']);
 source.fetch.mockClear();
 const empty=await notify(bindings,{...event,idempotencyKey:'empty',userIds:[]});await processNotification(bindings,empty.id);
 expect(source.fetch).not.toHaveBeenCalled();
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
 const call=vi.mocked(source.fetch).mock.calls.at(-1)!;
 expect(new URL(String(call[0])).searchParams.getAll('userId')).toEqual(['auth0|test']);
});
it('push credentials are owner-scoped, encrypted, and removed after provider expiry',async()=>{
 const keys=webpush.generateVAPIDKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:keys.publicKey,auth:Buffer.alloc(16,1).toString('base64url')}};
 const state=await savePush(bindings,'auth0|test',subscription);const id=(state.devices[0] as {id:string}).id;
 expect(JSON.stringify(await settings(bindings,'auth0|other'))).not.toContain(id);
 await expect(savePush(bindings,'auth0|other',subscription)).rejects.toThrow('PUSH_OWNED_BY_ANOTHER_ACCOUNT');
 await expect(savePush(bindings,'auth0|test',{...subscription,endpoint:'https://internal.invalid/secret'})).rejects.toThrow('INVALID_PUSH_SUBSCRIPTION');
 const pushEnv={...bindings,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
 const outgoing=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  // Exercise workerd's Request validation instead of accepting unsupported fetch options.
  const request=new Request(url,options);
  expect(request.headers.get('Content-Encoding')).toBe('aes128gcm');expect(request.redirect).toBe('manual');
  expect(await request.text()).not.toContain('private text');return new Response(null,{status:410});
 });
 try{await expect(deliver(pushEnv,{source:'test',idempotencyKey:'push',channel:'webpush',userId:'auth0|test',subscriptionId:id,subscription,title:'提醒',text:'private text',url:'/',tag:'test'},'test')).rejects.toThrow('PUSH_EXPIRED');}
 finally{outgoing.mockRestore();}
 expect((await settings(bindings,'auth0|test')).devices).toHaveLength(0);
});

it.each([201,302,307])('handles push HTTP %i without following redirects or deleting the device',async(status)=>{
 const keys=webpush.generateVAPIDKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:keys.publicKey,auth:Buffer.alloc(16,1).toString('base64url')}};
 const state=await savePush(bindings,'auth0|test',subscription);const id=(state.devices[0] as {id:string}).id;
 const pushEnv={...bindings,VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'};
 const outgoing=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const request=new Request(url,options);
  expect(request.redirect).toBe('manual');
  return new Response(null,{status,headers:{Location:'https://unexpected.invalid/push'}});
 });
 try{
  const result=deliver(pushEnv,{source:'test',idempotencyKey:'push',channel:'webpush',userId:'auth0|test',subscriptionId:id,subscription,title:'提醒',text:'private text',url:'/',tag:'test'},'test');
  if(status===201)await expect(result).resolves.toBe('test');
  else await expect(result).rejects.toMatchObject({code:`PUSH_${status}`,retryable:false});
  expect(outgoing).toHaveBeenCalledTimes(1);
  expect((await settings(bindings,'auth0|test')).devices).toHaveLength(1);
 }finally{outgoing.mockRestore();}
});

it('migrates the legacy operator channels once without overwriting user preferences',async()=>{
 await db.prepare('DELETE FROM notification_settings').run();
 const legacy={...bindings,LEGACY_WORKFLOW_USER_ID:'auth0|test',WORKFLOW_NOTIFICATION_EMAILS:'test@example.com',TELEGRAM_USER_ID:{get:async()=> '123'}};
 await migrateLegacyWorkflowSubscriber(legacy);
 expect((await settings(legacy,'auth0|test')).subscriptions.workflow).toEqual(['email','telegram']);
 await saveSettings(legacy,'auth0|test',configured);
 await migrateLegacyWorkflowSubscriber(legacy);
 expect((await settings(legacy,'auth0|test')).email).toBe('contact@example.com');
 expect((await settings(legacy,'auth0|test')).subscriptions.workflow).toEqual([]);
});
