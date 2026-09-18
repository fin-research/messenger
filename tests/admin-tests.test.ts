import {env} from 'cloudflare:test';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Resend} from 'resend';
import webpush from 'web-push';
import initial from '../migrations/0001_messages.sql?raw';
import notifications from '../migrations/0003_user_notifications.sql?raw';
import migration from '../migrations/0004_admin_test_batches.sql?raw';
import {sendTestMessages,recoverTestBatches} from '../src/admin-tests';
import {saveSettings,savePush} from '../src/notifications';
import {deliver} from '../src/providers';
import {admin} from '../src/index';
import type {Bindings,MessageInput} from '../src/contracts';
const db=(env as unknown as Bindings).DB;
const queue={send:vi.fn(async()=>{})};
const bindings={DB:db,QUEUE:queue,RESEND_API_KEY:'placeholder',FROM_EMAIL:'test@example.com'} as unknown as Bindings;
const input={requestId:'123e4567-e89b-42d3-a456-426614174000',actor:'auth0|admin',userIds:['auth0|one','auth0|missing'],channels:['email','telegram','webpush'],title:'通知测试',text:'<plain text>'};
const contact={email:'contact@example.com',telegramChatId:'123',subscriptions:{workflow:[],trading:[],financing:[]}};
beforeAll(async()=>{await db.batch((initial+'\n'+notifications+'\n'+migration).split(';').map(s=>s.trim()).filter(Boolean).map(sql=>db.prepare(sql)));});
beforeEach(async()=>{
 await db.batch(['retry_audit','attempts','messages','admin_test_batches','push_subscriptions','notification_settings'].map(table=>db.prepare(`DELETE FROM ${table}`)));
 queue.send.mockReset();queue.send.mockResolvedValue(undefined);
 await saveSettings(bindings,'auth0|one',contact);
});
afterEach(()=>vi.restoreAllMocks());
it('sends explicit tests to saved contacts and every device, independent of category subscriptions',async()=>{
 const keys=webpush.generateVAPIDKeys();
 for(const endpoint of ['one','two'])await savePush(bindings,'auth0|one',{endpoint:`https://fcm.googleapis.com/fcm/send/${endpoint}`,keys:{p256dh:keys.publicKey,auth:Buffer.alloc(16,1).toString('base64url')}});
 const result=await sendTestMessages(bindings,input);
 expect(result.deliveries).toBe(4);expect(result.skipped).toHaveLength(3);
 const messages=(await db.prepare('SELECT payload FROM messages').all<{payload:string}>()).results.map(row=>JSON.parse(row.payload));
 expect(messages.find(row=>row.channel==='email').to).toEqual(['contact@example.com']);
 expect(messages.find(row=>row.channel==='telegram').chatId).toBe('123');
 expect(messages.every(row=>row.adminTest.actor==='auth0|admin')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('fcm.googleapis.com');
});
it('concurrent duplicate batches and retries freeze contacts without duplicating messages',async()=>{
 await Promise.all([sendTestMessages(bindings,input),sendTestMessages(bindings,input)]);
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(2);
 await saveSettings(bindings,'auth0|one',{...contact,email:'changed@example.com'});
 await sendTestMessages(bindings,input);
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(2);
 await expect(sendTestMessages(bindings,{...input,text:'changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
 await expect(sendTestMessages(bindings,{...input,actor:'auth0|other'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
it('scheduled recovery completes large batches and handles queue outages without losing history',async()=>{
 const users=Array.from({length:30},(_,i)=>`auth0|test${i}`);
 for(const user of users)await saveSettings(bindings,user,contact);
 queue.send.mockRejectedValue(new Error('queue down'));
 const result=await sendTestMessages(bindings,{...input,userIds:users,channels:['email']});
 expect(result.deliveries).toBe(30);
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(25);
 await recoverTestBatches(bindings);
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(30);
 expect(await db.prepare('SELECT completed_at FROM admin_test_batches').first('completed_at')).not.toBeNull();
});
it('delivery rechecks contact changes while allowing unsubscribed explicit tests',async()=>{
 await sendTestMessages(bindings,input);
 const payload=JSON.parse((await db.prepare("SELECT payload FROM messages WHERE channel='email'").first<{payload:string}>())!.payload) as MessageInput;
 const provider=vi.spyOn(Resend.prototype,'fetchRequest').mockResolvedValue({data:{id:'accepted'},error:null,headers:null} as never);
 expect(await deliver(bindings,payload,'test')).toBe('accepted');
 await saveSettings(bindings,'auth0|one',{...contact,email:'new@example.com'});
 await expect(deliver(bindings,payload,'test')).rejects.toThrow('TEST_CONTACT_CHANGED');
 expect(provider).toHaveBeenCalledTimes(1);
});
it('private endpoint bounds batches and rejects arbitrary recipient overrides',async()=>{
 for(const raw of [{...input,to:['arbitrary@example.com']},{...input,userIds:[]},{...input,channels:['sms']},{...input,text:' '},{...input,userIds:Array.from({length:51},(_,i)=>`auth0|${i}`)}]){
 const response=await admin.request('/test-messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)},bindings);
 expect(response.status).toBe(422);
 }
 expect((await db.prepare('SELECT id FROM messages').all()).results).toHaveLength(0);
});
