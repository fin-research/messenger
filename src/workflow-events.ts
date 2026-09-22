import { z } from 'zod';
import { messageSchema, type Bindings, type MessageInput } from './contracts';
import { notify, migrateLegacyWorkflowSubscriber } from './notifications';

export const workflowBindings = {
  omo: 'OMO',
  'open-market': 'OPEN_MARKET', // Historical namespace; no new Cron instances.
  'market-briefing': 'MARKET_BRIEFING',
  article: 'ARTICLE',
  'article-cleanup': 'ARTICLE_CLEANUP',
  telegram: 'TELEGRAM',
  'policy-aggregation': 'POLICY_AGGREGATION',
  'bond-ledger-import': 'BOND_LEDGER_IMPORT',
  'financing-debt-import': 'FINANCING_DEBT_IMPORT',
  'economic-indicator-sync': 'ECONOMIC_INDICATOR_SYNC',
} as const;
export type WorkflowBindingName = typeof workflowBindings[keyof typeof workflowBindings];
const eventSchema = z.object({
  type: z.enum(['cf.workflows.workflow.instance.errored', 'cf.workflows.workflow.instance.completed', 'cf.workflows.workflow.instance.terminated']),
  source: z.object({ type: z.literal('workflows.workflow'), workflowName: z.string().min(1).max(128) }),
  payload: z.object({ versionId: z.string().min(1).max(128), instanceId: z.string().min(1).max(256) }),
  metadata: z.object({ accountId: z.string(), eventTimestamp: z.iso.datetime({ offset: true }), eventSchemaVersion: z.literal(1) }),
});
type WorkflowEvent = z.infer<typeof eventSchema>;
interface EventRow { id: string; event: string; messages: string | null; attempts: number; completed_at: number | null }
const errorSchema = z.object({ name: z.string(), message: z.string() });
const outputSchema = z.object({
  status: z.string().optional(), date: z.string().optional(), reportDate: z.string().optional(),
  text: z.string().optional(), focus: z.string().optional(),
}).passthrough();

/** Redact credentials in error strings before persisting or sending them; never log bodies. */
export function safeDetail(value: string): string {
  return value.replace(/https:\/\/api\.telegram\.org\/bot[^\s/]+/gi, 'https://api.telegram.org/bot[REDACTED]')
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Unwrap JSON error envelopes before rendering plain text for all channels. */
function formatDetail(value: unknown): string {
  const limit = 30_000;
  let text = '', truncated = false;
  function append(line: string) {
    const next = `${text ? '\n' : ''}${safeDetail(line)}`;
    truncated ||= text.length + next.length > limit;
    text += next.slice(0, limit - text.length);
  }
  function render(item: unknown, label = '', depth = 0) {
    if (text.length >= limit) { truncated = true; return; }
    const prefix = `${'  '.repeat(depth)}${label ? `${label}: ` : ''}`;
    if (depth > 16) { append(`${prefix}[详情层级过深]`); return; }
    // Bound both parsing and recursive traversal; ordinary strings remain literal.
    if (typeof item === 'string' && item.length <= 100_000 && /^[\s]*[\[{\"]/.test(item)) {
      try { render(JSON.parse(item), label, depth + 1); return; } catch { /* Plain text. */ }
    }
    if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item);
      if (!entries.length) { append(`${prefix}${Array.isArray(item) ? '[]' : '{}'}`); return; }
      if (label) append(prefix.trimEnd());
      for (const [key, child] of entries) {
        if (text.length >= limit) { truncated = true; break; }
        const sensitive = /(?:api[_-]?key|token|password|secret|authorization|cookie)$/i.test(key);
        render(sensitive ? '[REDACTED]' : child, Array.isArray(item) ? `[${Number(key) + 1}]` : key, depth + 1);
      }
      return;
    }
    append(`${prefix}${String(item)}`);
  }
  render(value);
  return text + (truncated ? '\n[详情已截断，请查看实例记录]' : '');
}

function businessFailures(value: unknown, path = 'output', depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  const item = value as Record<string, unknown>;
  const failed = ['failed', 'partial', 'not_found'].includes(String(item.status));
  const details: string[] = failed ? [`${path}.status=${String(item.status)}`] : [];
  for (const [key, child] of Object.entries(item)) {
    if (['failures', 'errors', 'error', 'message'].includes(key) && child && failed) {
      if (Array.isArray(child) && child.length === 0) continue;
      details.push(`${path}.${key}:\n${formatDetail(child)}`);
    } else if (!Array.isArray(child) && child && typeof child === 'object') {
      details.push(...businessFailures(child, `${path}.${key}`, depth + 1));
    }
  }
  return details;
}

export function notificationMessages(env: Bindings, event: WorkflowEvent, id: string, state: {status: string; error?: unknown; output?: unknown}): MessageInput[] {
  const name = event.source.workflowName;
  const issues = businessFailures(state.output);
  const failed = !event.type.endsWith('.completed') || issues.length > 0;
  if (!failed && !['omo', 'market-briefing'].includes(name)) return [];
  const label = failed ? (event.type.endsWith('.terminated') ? '已终止' : '失败') : '成功';
  const link = `https://dash.cloudflare.com/${event.metadata.accountId}/workers/workflows/${encodeURIComponent(name)}/instances/${encodeURIComponent(event.payload.instanceId)}`;
  const heading = `【Workflow ${label}】${name}`;
  const error = errorSchema.safeParse(state.error);
  const output = outputSchema.safeParse(state.output);
  const detail = failed
    ? [error.success ? `${error.data.name}: ${formatDetail(error.data.message)}` : '', ...issues,
      event.type.endsWith('.terminated') ? '实例被终止。' : '',
    ].filter(Boolean).join('\n') || `平台已发出失败事件，当前状态 ${state.status}；平台未返回原始错误详情，请查看实例记录。`
    : output.success ? name === 'omo' ? output.data.text ?? '公开市场播报已获取。'
      : `报告已归档。\n\n${output.data.focus ?? ''}\n\n报告：https://eastmoney.hasbai.xyz/market-briefing?date=${encodeURIComponent(output.data.reportDate ?? '')}`
    : 'Workflow 已完成。';
  // Notification delivery owns the title; the body must not repeat it.
  const text = `实例：${event.payload.instanceId}\n时间：${event.metadata.eventTimestamp}\n\n${detail}\n\n${link}`;
  const to = z.array(z.email()).min(1).max(50).parse([...new Set(env.WORKFLOW_NOTIFICATION_EMAILS.split(/[;,\s]+/).filter(Boolean))]);
  const result: MessageInput[] = [messageSchema.parse({ source: 'workflow', idempotencyKey: `${id}/email`, channel: 'email', to, subject: heading, text })];
  // Preserve all error details and business content in Telegram, splitting only at channel limits.
  const characters = Array.from(`${heading}\n${text}`);
  for (let start = 0, part = 0; start < characters.length; start += 1800, part++) {
    result.push(messageSchema.parse({ source: 'workflow', idempotencyKey: `${id}/telegram/${part}`, channel: 'telegram', text: characters.slice(start, start + 1800).join('') }));
  }
  return result;
}

export async function receiveWorkflowEvent(env: Bindings, raw: unknown, queuedAt?: number) {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success || parsed.data.metadata.accountId !== env.CLOUDFLARE_ACCOUNT_ID) throw new Error('INVALID_WORKFLOW_EVENT');
  const event = parsed.data;
  const receivedAt=Date.now();
  console.info('workflow_event_received',{instanceId:event.payload.instanceId,
    eventAgeMs:receivedAt-Date.parse(event.metadata.eventTimestamp),queueAgeMs:queuedAt===undefined?null:receivedAt-queuedAt});
  // Subscription IDs may change; the event identity must survive duplicate subscriptions and retries.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    event.metadata.accountId, event.source.workflowName, event.payload.instanceId,
    event.payload.versionId, event.type, event.metadata.eventTimestamp,
  ])));
  const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(`INSERT INTO workflow_events(id,event,created_at,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, JSON.stringify(event), Date.now(), Date.now()).run();
  // Once the inbox is durable the queue can ACK, even if lookup/enqueue is temporarily unavailable.
  await processWorkflowEvent(env, id);
}

export async function processWorkflowEvent(env: Bindings, id: string) {
  const row = await env.DB.prepare('SELECT * FROM workflow_events WHERE id=?').bind(id).first<EventRow>();
  if (!row || row.completed_at !== null) return;
  try {
    await migrateLegacyWorkflowSubscriber(env);
    if (!row.messages) {
      const event = eventSchema.parse(JSON.parse(row.event));
      const key = workflowBindings[event.source.workflowName as keyof typeof workflowBindings];
      const binding = key && env[key];
      if (!binding) throw new Error('WORKFLOW_BINDING_UNAVAILABLE');
      const state = await (await binding.get(event.payload.instanceId)).status();
      // Event publication and status visibility can briefly disagree; retain the inbox for retry.
      if (!['complete', 'errored', 'terminated'].includes(state.status)) throw new Error('WORKFLOW_STATUS_PENDING');
      if (event.type.endsWith('.errored') && state.status === 'errored' && !state.error) throw new Error('WORKFLOW_ERROR_PENDING');
      const messages = notificationMessages(env, event, id, state);
      await env.DB.prepare('UPDATE workflow_events SET messages=? WHERE id=? AND messages IS NULL')
        .bind(JSON.stringify(messages), id).run();
    }
    // Re-read the winning snapshot so concurrent consumers cannot enqueue different payloads.
    const snapshot = await env.DB.prepare('SELECT messages FROM workflow_events WHERE id=?').bind(id).first<{messages: string}>();
    const messages = z.array(messageSchema).parse(JSON.parse(snapshot!.messages));
    const email=messages.find(message=>message.channel==='email');
    if(email?.channel==='email') {
      const event=eventSchema.parse(JSON.parse(row.event));
      await notify(env,{source:'workflow',idempotencyKey:id,category:'workflow',title:email.subject,text:email.text ?? '',url:'/management/messenger'},
        {directTelegram:event.source.workflowName==='omo'&&event.type.endsWith('.completed')});
    }
    await env.DB.prepare('UPDATE workflow_events SET completed_at=?,last_error=NULL WHERE id=? AND completed_at IS NULL').bind(Date.now(), id).run();
  } catch {
    await env.DB.prepare(`UPDATE workflow_events SET attempts=attempts+1,next_attempt_at=?,last_error='WORKFLOW_EVENT_DEFERRED' WHERE id=? AND completed_at IS NULL`)
      .bind(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7)), id).run();
    console.warn('workflow_event_deferred');
  }
}

export async function recoverWorkflowEvents(env: Bindings, now = Date.now()) {
  const due = await env.DB.prepare('SELECT id FROM workflow_events WHERE completed_at IS NULL AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 20')
    .bind(now).all<{id: string}>();
  for (const row of due.results) await processWorkflowEvent(env, row.id);
}
