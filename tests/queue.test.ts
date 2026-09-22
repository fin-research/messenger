import { beforeEach, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/contracts';
import { processDeliveryBatch } from '../src/queue';
import { processMessage } from '../src/service';
import { processNotification } from '../src/notifications';

vi.mock('../src/service', () => ({ processMessage: vi.fn() }));
vi.mock('../src/notifications', () => ({ processNotification: vi.fn() }));

function message(id: string, kind?: 'notification'): Message<unknown> {
  return { id, body: { id, ...(kind ? { kind } : {}) }, timestamp: new Date(), attempts: 1,
    ack: vi.fn(), retry: vi.fn() };
}
function batch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return { queue: 'messenger', messages, ackAll: vi.fn(), retryAll: vi.fn() };
}
const all = vi.fn();
const bindings = { DB: { prepare: () => ({ bind: () => ({ all }) }) } } as unknown as Bindings;
beforeEach(() => {
  vi.resetAllMocks();
  all.mockResolvedValue({ results: [
    { id: 'email', channel: 'email' }, { id: 'telegram-1', channel: 'telegram' },
    { id: 'telegram-2', channel: 'telegram' }, { id: 'push', channel: 'webpush' },
  ] });
});

it('a slow email or notification does not block other channels; Telegram chunks keep batch order', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  vi.mocked(processMessage).mockImplementation(async (_env, id) => { started.push(id); await gate; });
  vi.mocked(processNotification).mockImplementation(async () => { started.push('notification'); await gate; });
  const messages = [message('email'), message('telegram-1'), message('telegram-2'), message('push'), message('notification', 'notification')];
  const pending = processDeliveryBatch(batch(messages), bindings);
  try {
    await vi.waitFor(() => expect(started).toEqual(['email', 'telegram-1', 'push', 'notification']));
    expect(messages.every(item => vi.mocked(item.ack).mock.calls.length === 0)).toBe(true);
  } finally { release(); await pending; }
  expect(started).toEqual(['email', 'telegram-1', 'push', 'notification', 'telegram-2']);
  for (const item of messages) { expect(item.ack).toHaveBeenCalledOnce(); expect(item.retry).not.toHaveBeenCalled(); }
});

it('retries only the failed item and continues both its lane and other channels', async () => {
  vi.mocked(processMessage).mockImplementation(async (_env, id) => { if (id === 'telegram-1') throw new Error('database unavailable'); });
  const messages = [message('telegram-1'), message('telegram-2'), message('email')];
  await processDeliveryBatch(batch(messages), bindings);
  expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  expect(messages[0].ack).not.toHaveBeenCalled();
  for (const item of messages.slice(1)) { expect(item.ack).toHaveBeenCalledOnce(); expect(item.retry).not.toHaveBeenCalled(); }
});

it('metadata failures retry valid items without invoking sends; malformed items are acknowledged', async () => {
  all.mockRejectedValue(new Error('database unavailable'));
  const invalid = { ...message('invalid'), body: { invalid: true } };
  const valid = message('email');
  await processDeliveryBatch(batch([invalid, valid]), bindings);
  expect(invalid.ack).toHaveBeenCalledOnce();
  expect(valid.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  expect(valid.ack).not.toHaveBeenCalled();
  expect(processMessage).not.toHaveBeenCalled();
});
