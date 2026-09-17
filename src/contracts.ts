import { z } from 'zod';
import type { WorkflowBindingName } from './workflow-events';

const common = {
  source: z.string().regex(/^[a-z0-9-]{1,64}$/),
  idempotencyKey: z.string().min(1).max(240),
};
export const messageSchema = z.discriminatedUnion('channel', [
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
  DB: D1Database;
  QUEUE: Queue<{ id: string }>;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  TELEGRAM_BOT_TOKEN: { get(): Promise<string> };
  TELEGRAM_USER_ID: { get(): Promise<string> };
}
export interface MessageRow {
 id: string; source: string; idempotency_key: string; payload: string; channel: 'email'|'telegram';
 status: 'queued'|'processing'|'retrying'|'accepted'|'failed'|'uncertain';
 attempts: number; cycle_attempts: number; generation: number; provider_id: string|null;
 last_error: string|null; created_at: number; updated_at: number; next_attempt_at: number;
 first_attempt_at: number|null; lease_until: number|null; lease_token: string|null;
}
