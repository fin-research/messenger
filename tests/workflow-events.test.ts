import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import messagesSchema from '../migrations/0001_messages.sql?raw';
import eventsSchema from '../migrations/0002_workflow_events.sql?raw';
import { receiveWorkflowEvent, recoverWorkflowEvents, safeDetail } from '../src/workflow-events';
import type { Bindings } from '../src/contracts';
const db = (env as unknown as Bindings).DB;
const account = '5cecc63c78acf8f5473f8745f4244448';
const status = vi.fn();
const binding = { get: vi.fn(async () => ({status})) };
const bindings = {DB:db, QUEUE:{send:vi.fn(async()=>{})}, CLOUDFLARE_ACCOUNT_ID:account, WORKFLOW_NOTIFICATION_EMAILS:'test@example.com',
  OMO:binding, MARKET_BRIEFING:binding, ARTICLE:binding, ECONOMIC_INDICATOR_SYNC:binding } as unknown as Bindings;
const event = (name='article', type='errored', timestamp='2026-09-17T01:25:00.000Z') => ({
  type:`cf.workflows.workflow.instance.${type}`,source:{type:'workflows.workflow',workflowName:name},
  payload:{versionId:'v1',instanceId:'instance-1'},metadata:{accountId:account,eventTimestamp:timestamp,eventSchemaVersion:1,eventSubscriptionId:'subscription-1'},
});
const contents = async () => (await db.prepare('SELECT payload FROM messages ORDER BY channel,idempotency_key').all<{payload:string}>()).results.map(row=>JSON.parse(row.payload));
beforeAll(async()=>{ await db.batch((messagesSchema+'\n'+eventsSchema).split(';').map(x=>x.trim()).filter(Boolean).map(sql=>db.prepare(sql))); });
beforeEach(async()=>{
  await db.batch(['DELETE FROM retry_audit','DELETE FROM attempts','DELETE FROM messages','DELETE FROM workflow_events'].map(sql=>db.prepare(sql)));
  status.mockReset(); status.mockResolvedValue({status:'errored',error:{name:'Error',message:'fetch-industry: HTTP 503'}});
  vi.mocked(bindings.QUEUE.send).mockReset();
});
describe('Workflow events inbox',()=>{
  it('notifies both channels with actual error details and deduplicates deliveries across subscriptions',async()=>{
    const source=event();
    await Promise.all([receiveWorkflowEvent(bindings,source),receiveWorkflowEvent(bindings,{...source,metadata:{...source.metadata,eventSubscriptionId:'replacement'}})]);
    const messages=await contents(); expect(messages).toHaveLength(2);
    expect(messages.map(x=>x.channel)).toEqual(['email','telegram']);
    expect(messages[0].text).toContain('Error: fetch-industry: HTTP 503');
    expect(messages[0].text).toContain('/workflows/article/instances/instance-1');
    await receiveWorkflowEvent(bindings,source); expect(await contents()).toHaveLength(2);
  });
  it.each(['omo','market-briefing'])('notifies %s success using Workflow output',async name=>{
    status.mockResolvedValue({status:'complete',output:{status:'complete',text:'净投放1590亿元。',focus:'股市判断\n债市判断',reportDate:'2026-09-17'}});
    await receiveWorkflowEvent(bindings,event(name,'completed'));
    const messages=await contents(); expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain(name==='omo'?'净投放1590亿元。':'股市判断\n债市判断');
  });
  it('suppresses ordinary success but reports nested business partial failures',async()=>{
    status.mockResolvedValue({status:'complete',output:{status:'archived'}});
    await receiveWorkflowEvent(bindings,event('article','completed')); expect(await contents()).toHaveLength(0);
    status.mockResolvedValue({status:'complete',output:{status:'complete',quant:{status:'partial',failures:[{step:'choice-css',error:'HTTP 503'}]}}});
    await receiveWorkflowEvent(bindings,event('economic-indicator-sync','completed'));
    expect((await contents())[0].text).toContain('choice-css');
  });
  it('recovers lookup failure durably and never acknowledges away notification work',async()=>{
    status.mockRejectedValueOnce(new Error('binding unavailable'));
    await receiveWorkflowEvent(bindings,event()); expect(await contents()).toHaveLength(0);
    expect(await db.prepare('SELECT attempts,completed_at FROM workflow_events').first()).toMatchObject({attempts:1,completed_at:null});
    await recoverWorkflowEvents(bindings,Date.now()+60_000); expect(await contents()).toHaveLength(2);
  });
  it('freezes payloads before channel enqueue so partial failures and replay cannot conflict',async()=>{
    await db.prepare("CREATE TRIGGER reject_telegram BEFORE INSERT ON messages WHEN NEW.channel='telegram' BEGIN SELECT RAISE(FAIL,'temporary storage outage'); END").run();
    try { await receiveWorkflowEvent(bindings,event()); expect(await contents()).toHaveLength(1); }
    finally { await db.prepare('DROP TRIGGER reject_telegram').run(); }
    status.mockResolvedValue({status:'complete',output:{text:'changed after restart'}});
    await recoverWorkflowEvents(bindings,Date.now()+60_000);
    const messages=await contents(); expect(messages).toHaveLength(2);
    expect(messages.every(x=>x.text.includes('HTTP 503'))).toBe(true);
  });
  it('keeps new failure occurrences after restart distinct and survives outbound queue outage',async()=>{
    vi.mocked(bindings.QUEUE.send).mockRejectedValue(new Error('queue unavailable'));
    await receiveWorkflowEvent(bindings,event());
    await receiveWorkflowEvent(bindings,event('article','errored','2026-09-17T02:25:00.000Z'));
    expect(await contents()).toHaveLength(4);
  });
  it('splits long Telegram errors without losing detail and redacts credential strings',async()=>{
    status.mockResolvedValue({status:'errored',error:{name:'Error',message:'token=private '+ '详细错误'.repeat(1200)}});
    await receiveWorkflowEvent(bindings,event()); const messages=await contents();
    const telegram=messages.filter(x=>x.channel==='telegram'); expect(telegram.length).toBeGreaterThan(1);
    expect(telegram.every(x=>x.text.length<=4096)).toBe(true);
    expect(telegram.map(x=>x.text).join('')).toBe(messages[0].text);
    expect(messages[0].text).not.toContain('private');
    expect(safeDetail('https://api.telegram.org/bot123:abc/sendMessage Bearer abc')).not.toContain('123:abc');
  });
  it('rejects invalid schemas and wrong accounts before persistence',async()=>{
    const source=event();
    await expect(receiveWorkflowEvent(bindings,{...source,metadata:{...source.metadata,accountId:'other'}})).rejects.toThrow('INVALID_WORKFLOW_EVENT');
    await expect(receiveWorkflowEvent(bindings,{type:'unknown'})).rejects.toThrow();
    expect((await db.prepare('SELECT id FROM workflow_events').all()).results).toHaveLength(0);
  });
});
