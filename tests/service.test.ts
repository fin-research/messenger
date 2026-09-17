import subscriptionsSchema from '../migrations/0003_user_notifications.sql?raw';
import { env } from 'cloudflare:test';
import { beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import schema from '../migrations/0001_messages.sql?raw';
import { enqueue,getMessage,processMessage,recover,retryMessage } from '../src/service';
import { DeliveryError } from '../src/providers';
import worker,{sender,admin} from '../src/index';
import type {Bindings} from '../src/contracts';
const db=(env as unknown as Bindings).DB;
const queue={send:vi.fn(async()=>{})};
const bindings={DB:db,QUEUE:queue} as unknown as Bindings;
const input={source:'test',idempotencyKey:'event-1',channel:'telegram',text:'测试通知'};
beforeAll(async()=>{await db.batch((schema+'\n'+subscriptionsSchema).split(';').map(x=>x.trim()).filter(Boolean).map(sql=>db.prepare(sql)));});
beforeEach(async()=>{await db.batch(['DELETE FROM retry_audit','DELETE FROM attempts','DELETE FROM messages'].map(sql=>db.prepare(sql)));queue.send.mockReset();queue.send.mockResolvedValue(undefined);});
describe('durable messenger',()=>{
 it('persists before enqueue, survives queue outage and deduplicates submissions',async()=>{
   queue.send.mockRejectedValue(new Error('queue down'));
   const first=await enqueue(bindings,input),again=await enqueue(bindings,input);
   expect(again.id).toBe(first.id);expect((await getMessage(bindings,first.id))?.status).toBe('queued');
   await expect(enqueue(bindings,{...input,text:'changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
   queue.send.mockResolvedValue(undefined);await recover(bindings);expect(queue.send).toHaveBeenLastCalledWith({id:first.id});
 });
 it('claims once across duplicate consumers and skips accepted messages',async()=>{
   const row=await enqueue(bindings,input),send=vi.fn(async()=> '42');
   await Promise.all([processMessage(bindings,row.id,send),processMessage(bindings,row.id,send)]);
   await processMessage(bindings,row.id,send);expect(send).toHaveBeenCalledTimes(1);
   expect(await getMessage(bindings,row.id)).toMatchObject({status:'accepted',provider_id:'42',attempts:1});
 });
 it('backs off a throttled request and exhausts the retry budget',async()=>{
   const row=await enqueue(bindings,input),send=vi.fn(async()=>{throw new DeliveryError('TELEGRAM_429',true,false,120);});
   for(let n=1;n<=6;n++){
     await db.prepare('UPDATE messages SET next_attempt_at=0 WHERE id=?').bind(row.id).run();
     await processMessage(bindings,row.id,send);
   }
   expect(await getMessage(bindings,row.id)).toMatchObject({status:'failed',attempts:6});
   expect(queue.send).toHaveBeenCalledWith({id:row.id},{delaySeconds:120});
 });
 it('does not automatically repeat an ambiguous Telegram send; manual replay is audited',async()=>{
   const row=await enqueue(bindings,input);
   await processMessage(bindings,row.id,async()=>{throw new DeliveryError('TRANSPORT',false,true);});
   await expect(retryMessage(bindings,row.id,'auth0|admin',false)).rejects.toThrow('CONFIRM_UNCERTAIN_REQUIRED');
   const calls=await Promise.allSettled([retryMessage(bindings,row.id,'auth0|admin',true),retryMessage(bindings,row.id,'auth0|admin',true)]);
   expect(calls.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   expect(await getMessage(bindings,row.id)).toMatchObject({status:'queued',generation:1,attempts:1,cycle_attempts:0});
   expect((await db.prepare('SELECT * FROM retry_audit').all()).results).toHaveLength(1);
 });
 it('recovers an interrupted lease without repeating Telegram',async()=>{
   const row=await enqueue(bindings,input);
   await db.prepare("UPDATE messages SET status='processing',lease_until=1,lease_token='old',attempts=1 WHERE id=?").bind(row.id).run();
   await recover(bindings);expect((await getMessage(bindings,row.id))?.status).toBe('uncertain');
 });
 it('a late provider response cannot overwrite a recovered attempt',async()=>{
   const row=await enqueue(bindings,input);
   let finish!: (value:string)=>void,started!:()=>void;
   const ready=new Promise<void>(resolve=>started=resolve);
   const pending=processMessage(bindings,row.id,async()=>{started();return new Promise<string>(resolve=>finish=resolve);});
   await ready;
   await recover(bindings,Date.now()+180_000);
   finish('late-provider-id');await pending;
   expect((await getMessage(bindings,row.id))?.status).toBe('uncertain');
   expect(await db.prepare('SELECT status,provider_id FROM attempts WHERE message_id=?').bind(row.id).first()).toEqual({status:'uncertain',provider_id:null});
 });
 it('reuses the email provider key within its window and stops outside it',async()=>{
   const row=await enqueue(bindings,{source:'test',idempotencyKey:'mail',channel:'email',to:['a@example.com'],subject:'Subject',text:'Body'});
   const send=vi.fn(async()=>{throw new DeliveryError('EMAIL_TRANSPORT_ERROR',true,true);});
   await processMessage(bindings,row.id,send);
   await db.prepare('UPDATE messages SET next_attempt_at=0 WHERE id=?').bind(row.id).run();
   await processMessage(bindings,row.id,send);
   expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
   await db.prepare('UPDATE messages SET first_attempt_at=1,next_attempt_at=0 WHERE id=?').bind(row.id).run();
   await processMessage(bindings,row.id,send);expect(send).toHaveBeenCalledTimes(2);
   expect((await getMessage(bindings,row.id))?.status).toBe('uncertain');
 });
 it('keeps public fetch closed and validates submissions, pagination, and replay states',async()=>{
   expect(worker.fetch().status).toBe(404);
   expect((await sender.request('/messages',{method:'POST',body:JSON.stringify({...input,unexpected:true}),headers:{'Content-Type':'application/json'}},bindings)).status).toBe(422);
   const row=await enqueue(bindings,input);await enqueue(bindings,{...input,idempotencyKey:'second'});
   const first=await (await admin.request('/messages?limit=1',{},bindings)).json() as any;
   const second=await (await admin.request(`/messages?limit=1&before=${first.nextCursor}`,{},bindings)).json() as any;
   expect(second.items[0].id).toBe(row.id);expect(second.nextCursor).toBeNull();
   await processMessage(bindings,row.id,async()=> '1');
   await expect(retryMessage(bindings,row.id,'admin',true)).rejects.toThrow('NOT_RETRYABLE');
 });
});
