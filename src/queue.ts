import { z } from 'zod';
import type { Bindings } from './contracts';
import { processNotification } from './notifications';
import { processMessage } from './service';

const queueItemSchema = z.object({ id: z.string(), kind: z.literal('notification').optional() });

/** Different channels can progress independently; each channel keeps batch order. */
export async function processDeliveryBatch(batch: MessageBatch<unknown>, env: Bindings) {
  const items = batch.messages.flatMap(message => {
    const parsed = queueItemSchema.safeParse(message.body);
    if (!parsed.success) { message.ack(); return []; }
    return [{ message, input: parsed.data }];
  });
  const ids = items.filter(item => !item.input.kind).map(item => item.input.id);
  const channelById = new Map<string, string>();
  if (ids.length) {
    try {
      const rows = await env.DB.prepare(`SELECT id,channel FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids).all<{id:string;channel:string}>();
      for (const row of rows.results) channelById.set(row.id, row.channel);
    } catch {
      // A metadata read failure must not acknowledge unprocessed deliveries.
      for (const item of items) item.message.retry({ delaySeconds: 120 });
      return;
    }
  }
  const lanes = new Map<string, Promise<void>>();
  for (const { message, input } of items) {
    const lane = input.kind ?? channelById.get(input.id) ?? 'missing';
    const previous = lanes.get(lane) ?? Promise.resolve();
    lanes.set(lane, previous.then(async () => {
      const started = Date.now();
      try {
        if (input.kind === 'notification') await processNotification(env, input.id);
        else await processMessage(env, input.id);
        message.ack();
      } catch { message.retry({ delaySeconds: 120 }); }
      finally {
        console.info('messenger_queue_item', { id: input.id, lane,
          queueAgeMs: started - message.timestamp.getTime(), processingMs: Date.now() - started });
      }
    }));
  }
  await Promise.all(lanes.values());
}
