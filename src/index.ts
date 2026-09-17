import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Bindings, MessageRow } from './contracts';
import { dto, enqueue, getMessage, processMessage, recover, retryMessage } from './service';

export const sender = new Hono<{Bindings: Bindings}>();
export const admin = new Hono<{Bindings: Bindings}>();
for (const app of [sender,admin]) {
  app.use('*',bodyLimit({maxSize: 450_000}));
  app.onError((error,c) => error instanceof HTTPException ? c.json({error:error.message},error.status) : c.json({error:'MESSENGER_UNAVAILABLE'},503));
}
sender.post('/messages',async c => c.json(await enqueue(c.env,await c.req.json()),202));
sender.get('/messages/:id',async c => {
  const row=await getMessage(c.env,c.req.param('id'));
  return row ? c.json(dto(row)) : c.json({error:'NOT_FOUND'},404);
});
const filterSchema=z.object({status:z.enum(['queued','processing','retrying','accepted','failed','uncertain']).optional(),channel:z.enum(['email','telegram']).optional(),source:z.string().max(64).optional(),before:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(30)});
admin.get('/messages',async c => {
  const parsed=filterSchema.safeParse(c.req.query());
  if(!parsed.success)return c.json({error:'INVALID_FILTER'},422);
  const f=parsed.data, conditions:string[]=[], values:(string|number)[]=[];
  for(const field of ['status','channel','source'] as const)if(f[field]){conditions.push(`${field}=?`);values.push(f[field]!);}
  // Cursor uses SQLite rowid, avoiding ties on millisecond creation timestamps.
  if(f.before){conditions.push('rowid<?');values.push(f.before);}
  const rows=await c.env.DB.prepare(`SELECT rowid AS cursor,* FROM messages ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY rowid DESC LIMIT ?`).bind(...values,f.limit+1).all<MessageRow & {cursor:number}>();
  const page=rows.results.slice(0,f.limit);
  const counts=await c.env.DB.prepare('SELECT status,COUNT(*) AS count FROM messages GROUP BY status').all<{status:string;count:number}>();
  return c.json({items:page.map(dto),nextCursor:rows.results.length>f.limit?page.at(-1)!.cursor:null,counts:counts.results});
});
admin.get('/messages/:id',async c => {
  const row=await getMessage(c.env,c.req.param('id'));
  if(!row)return c.json({error:'NOT_FOUND'},404);
  const attempts=await c.env.DB.prepare('SELECT number,started_at,finished_at,status,provider_id,error FROM attempts WHERE message_id=? ORDER BY number DESC LIMIT 100').bind(row.id).all();
  const audit=await c.env.DB.prepare('SELECT actor,created_at,previous_status FROM retry_audit WHERE message_id=? ORDER BY id DESC LIMIT 100').bind(row.id).all();
  return c.json({...dto(row),content:JSON.parse(row.payload),history:attempts.results,retries:audit.results});
});
admin.post('/messages/:id/retry',async c => {
  const value=z.object({actor:z.string().min(1).max(200),confirmUncertain:z.boolean().default(false)}).safeParse(await c.req.json());
  if(!value.success)return c.json({error:'INVALID_RETRY'},422);
  return c.json(await retryMessage(c.env,c.req.param('id'),value.data.actor,value.data.confirmUncertain),202);
});
export class Messaging extends WorkerEntrypoint<Bindings> { fetch(request:Request){return sender.fetch(request,this.env,this.ctx);} }
export class MessengerAdmin extends WorkerEntrypoint<Bindings> { fetch(request:Request){return admin.fetch(request,this.env,this.ctx);} }
export default {
  fetch(){return new Response('Not Found',{status:404});},
  async queue(batch:MessageBatch<{id:string}>,env:Bindings){
    for(const message of batch.messages){
      if(!message.body || typeof message.body.id!=='string'){message.ack();continue;}
      try{await processMessage(env,message.body.id);message.ack();}catch{message.retry({delaySeconds:120});}
    }
  },
  async scheduled(_event:ScheduledController,env:Bindings){await recover(env);},
} satisfies ExportedHandler<Bindings,{id:string}>;
