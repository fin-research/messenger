import { z } from 'zod';
import type { WorkflowBindingName } from './workflow-events';

const common = {
  adminTest: z.object({userId:z.string().min(1),actor:z.string().min(1)}).strict().optional(),
  notification: z.object({userId:z.string().min(1),category:z.enum(['workflow','trading','financing'])}).strict().optional(),
  source: z.string().regex(/^[a-z0-9-]{1,64}$/),
  idempotencyKey: z.string().min(1).max(240),
};
export const pushSubscriptionSchema = z.object({
 endpoint: z.url().max(2048).refine(value => {
   const url = new URL(value);
   return url.protocol === 'https:' && !url.port && !url.username && !url.password
     && (['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(url.hostname) || url.hostname.endsWith('.notify.windows.com'));
 }, 'Unsupported push service'),
 keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/) }).strict(),
 expirationTime: z.number().nullable().optional(),
}).strict();
export const messageSchema = z.discriminatedUnion('channel', [
  z.object({ ...common, channel: z.literal('webpush'), userId: z.string().min(1), subscriptionId: z.string().uuid(),
    subscription: pushSubscriptionSchema, title: z.string().max(500), text: z.string().max(2000), url: z.string().max(2048), tag: z.string().max(240) }).strict(),
  z.object({ ...common, channel: z.literal('email'), profile: z.enum(['default','market-briefing']).default('default'),
    to: z.array(z.email()).min(1).max(50), subject: z.string().min(1).max(500),
    text: z.string().max(200_000).optional(), html: z.string().max(200_000).optional(),
  }).strict().refine(v => !!(v.text || v.html), 'Email body required'),
  z.object({ ...common, channel: z.literal('telegram'), text: z.string().min(1).max(4096),
    chatId: z.string().regex(/^-?\d+$/).optional(),
  }).strict(),
]);
export type MessageInput = z.infer<typeof messageSchema>;
export interface Bindings extends Partial<Record<WorkflowBindingName, Workflow>> {
  CLOUDFLARE_ACCOUNT_ID: string;
  WORKFLOW_NOTIFICATION_EMAILS: string;
  LEGACY_WORKFLOW_USER_ID?: string;
  DB: D1Database;
  QUEUE: Queue<{ id: string; kind?: 'notification' }>;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  NOTIFICATION_SOURCE?: Fetcher;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  TELEGRAM_BOT_TOKEN: { get(): Promise<string> };
  TELEGRAM_USER_ID: { get(): Promise<string> };
}
export interface MessageRow {
 id: string; source: string; idempotency_key: string; payload: string; channel: 'email'|'telegram'|'webpush';
 status: 'queued'|'processing'|'retrying'|'accepted'|'failed'|'uncertain';
 attempts: number; cycle_attempts: number; generation: number; provider_id: string|null;
 last_error: string|null; created_at: number; updated_at: number; next_attempt_at: number;
 first_attempt_at: number|null; lease_until: number|null; lease_token: string|null;
}
