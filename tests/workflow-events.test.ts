import { processNotification, saveSettings } from '../src/notifications';
import subscriptionsSchema from '../migrations/0003_user_notifications.sql?raw';
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import messagesSchema from '../migrations/0001_messages.sql?raw';
import eventsSchema from '../migrations/0002_workflow_events.sql?raw';
import { receiveWorkflowEvent, recoverWorkflowEvents, safeDetail } from '../src/workflow-events';
import type { Bindings } from '../src/contracts';
import { deliver, DeliveryError } from '../src/providers';
import { processMessage } from '../src/service';
vi.mock('../src/providers', async importOriginal => ({...await importOriginal<typeof import('../src/providers')>(), deliver:vi.fn(async()=> 'accepted-test')}));
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
const contents = async () => {for(const row of (await db.prepare('SELECT id FROM notifications WHERE completed_at IS NULL').all<{id:string}>()).results)await processNotification(bindings,row.id);return (await db.prepare('SELECT payload FROM messages ORDER BY channel,idempotency_key').all<{payload:string}>()).results.map(row=>JSON.parse(row.payload));};
beforeAll(async()=>{ await db.batch((messagesSchema+'\n'+eventsSchema+'\n'+subscriptionsSchema).split(';').map(x=>x.trim()).filter(Boolean).map(sql=>db.prepare(sql))); });
beforeEach(async()=>{
  await db.batch(['DELETE FROM retry_audit','DELETE FROM attempts','DELETE FROM messages','DELETE FROM workflow_events','DELETE FROM notifications','DELETE FROM notification_settings'].map(sql=>db.prepare(sql)));
  await saveSettings(bindings,'auth0|test',{email:'test@example.com',telegramChatId:'123',subscriptions:{workflow:['email','telegram'],trading:[],financing:[]}});
  status.mockReset(); status.mockResolvedValue({status:'errored',error:{name:'Error',message:'fetch-industry: HTTP 503'}});
  vi.mocked(bindings.QUEUE.send).mockReset();
  vi.mocked(deliver).mockReset();vi.mocked(deliver).mockResolvedValue('accepted-test');
});
describe('Workflow events inbox',()=>{
  it('OMO sends its durable Telegram immediately even when the queue is unavailable, without duplicates',async()=>{
    status.mockResolvedValue({status:'complete',output:{status:'found',text:'净投放350亿元。'}});
    vi.mocked(bindings.QUEUE.send).mockRejectedValue(new Error('queue unavailable'));
    vi.mocked(deliver).mockImplementation(async(_env,input)=>{
      expect(input.channel).toBe('telegram');
      expect(input.notification).toEqual({userId:'auth0|test',category:'workflow'});
      expect(await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel='telegram' AND status='processing'").first()).toEqual({n:1});
      return 'telegram-accepted';
    });
    const source=event('omo','completed');
    await Promise.all([receiveWorkflowEvent(bindings,source),receiveWorkflowEvent(bindings,source)]);
    const telegram=await db.prepare("SELECT id,status,attempts FROM messages WHERE channel='telegram'").first<{id:string;status:string;attempts:number}>();
    expect(telegram).toMatchObject({status:'accepted',attempts:1});
    await processMessage(bindings,telegram!.id);
    await receiveWorkflowEvent(bindings,source);
    expect(deliver).toHaveBeenCalledOnce();
    expect(await db.prepare("SELECT status FROM messages WHERE channel='email'").first()).toEqual({status:'queued'});
  });
  it('OMO inline Telegram keeps uncertain results final for automatic queue retries',async()=>{
    status.mockResolvedValue({status:'complete',output:{text:'净投放350亿元。'}});
    vi.mocked(deliver).mockRejectedValue(new DeliveryError('TELEGRAM_TRANSPORT_ERROR',false,true));
    await receiveWorkflowEvent(bindings,event('omo','completed'));
    const telegram=await db.prepare("SELECT id,status FROM messages WHERE channel='telegram'").first<{id:string;status:string}>();
    expect(telegram?.status).toBe('uncertain');
    await processMessage(bindings,telegram!.id);
    expect(deliver).toHaveBeenCalledOnce();
  });
  it('multi-fragment OMO uses the existing ordered queue instead of racing inline fragments',async()=>{
    status.mockResolvedValue({status:'complete',output:{text:'公开市场操作'.repeat(600)}});
    await receiveWorkflowEvent(bindings,event('omo','completed'));
    expect((await db.prepare("SELECT id FROM messages WHERE channel='telegram'").all()).results.length).toBeGreaterThan(1);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('notifies both channels with actual error details and deduplicates deliveries across subscriptions',async()=>{
    const source=event();
    await Promise.all([receiveWorkflowEvent(bindings,source),receiveWorkflowEvent(bindings,{...source,metadata:{...source.metadata,eventSubscriptionId:'replacement'}})]);
    const messages=await contents(); expect(messages).toHaveLength(2);
    expect(messages.map(x=>x.channel)).toEqual(['email','telegram']);
    expect(messages[0].text).toContain('Error: fetch-industry: HTTP 503');
    expect(messages[0].text).toContain('/workflows/article/instances/instance-1');
    expect(messages[0].text).not.toContain(messages[0].subject);
    expect(messages[1].text.split(messages[0].subject)).toHaveLength(2);
    await receiveWorkflowEvent(bindings,source); expect(await contents()).toHaveLength(2);
  });
  it.each(['omo','market-briefing'])('notifies %s success using Workflow output',async name=>{
    status.mockResolvedValue({status:'complete',output:{status:'complete',text:'净投放1590亿元。',focus:'股市判断\n债市判断',reportDate:'2026-09-17'}});
    await receiveWorkflowEvent(bindings,event(name,'completed'));
    const messages=await contents(); expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain(name==='omo'?'净投放1590亿元。':'股市判断\n债市判断');
    expect(messages[1].text.split(messages[0].subject)).toHaveLength(2);
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
  it.each(['completed','errored'])('renders nested JSON errors as readable, redacted text for %s',async type=>{
    const error = JSON.stringify({path:'/choice/ctr',parameters:{reportName:'BondTradingStatistics'},status:503,
      responseBody:JSON.stringify({detail:'user has no access for this API',error:{upstreamResponse:{
        body:JSON.stringify({error:{code:'CHOICE_UPSTREAM',upstreamCode:10001003,message:'user has no access for this API'},
          authorization:'Bearer private credential',accessToken:'another secret'}),
      }}})});
    const output={status:'partial',failures:[],quant:{status:'partial',failures:[
      {source:'primary-2026-09-19',error:'Stored date has missing fields: WEIGHTED_COST'},
      {source:'secondary',error},
    ]}};
    status.mockResolvedValue(type==='completed'?{status:'complete',output}
      :{status:'errored',error:{name:'Error',message:JSON.stringify(output)}});
    await receiveWorkflowEvent(bindings,event('economic-indicator-sync',type));
    const messages=await contents();
    const text=messages.filter(x=>x.channel==='telegram').map(x=>x.text).join('');
    for(const detail of ['source: secondary','reportName: BondTradingStatistics','upstreamCode: 10001003',
      'user has no access for this API','WEIGHTED_COST','[REDACTED]'])expect(text).toContain(detail);
    for(const escaped of ['\\"','\\_','\\\n','private credential','another secret'])expect(text).not.toContain(escaped);
    expect(text.split('【Workflow 失败】economic-indicator-sync')).toHaveLength(2);
    if(type==='completed')expect(text).not.toContain('output.failures:');
  });
  it('preserves literal backslashes in non-JSON errors',async()=>{
    const message=String.raw`read C:\reports\input.json: expected "WEIGHTED_COST"`;
    status.mockResolvedValue({status:'errored',error:{name:'Error',message}});
    await receiveWorkflowEvent(bindings,event());
    expect((await contents())[0].text).toContain(message);
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
    expect(telegram.map(x=>x.text).join('')).toBe(messages[0].subject+'\n'+messages[0].text);
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
