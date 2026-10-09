import { afterEach, expect, test, vi } from 'vitest';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => JSON.stringify({
  account_id: 'test', workflows: [{ name: 'economic-indicator-sync' }],
})) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

async function plan(names, subscriptions = []) {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi.fn(async path => Response.json({ success: true, result:
    path.includes('/event_subscriptions/') ? subscriptions : path.includes('/queues?')
      ? [{ queue_name: 'messenger-workflow-events', queue_id: 'queue' }]
      : names.map(name => ({ name })),
  }));
  vi.stubGlobal('fetch', fetch);
  await import('../scripts/sync-workflow-subscriptions.mjs');
  return { log, fetch };
}
test('internal DM child is excluded while parent still receives completed events', async () => {
  const { log, fetch } = await plan(['economic-indicator-sync', 'dm-funding-sync']);
  expect(log.mock.calls.flat()).toEqual(['create messenger-economic-indicator-sync: instance.errored,instance.terminated,instance.completed']);
  expect(fetch.mock.calls.every(([_path, options]) => options.method === 'GET')).toBe(true);
});
test('other unknown workflows still require explicit Messenger configuration', async () => {
  await expect(plan(['economic-indicator-sync', 'unconfigured-workflow'])).rejects.toThrow('Add cross-script bindings');
});
test('internal child does not change an existing exact parent subscription', async () => {
  const { log } = await plan(['economic-indicator-sync', 'dm-funding-sync'], [{
    name: 'messenger-economic-indicator-sync', enabled: true,
    source: { type: 'workflows.workflow', workflow_name: 'economic-indicator-sync' },
    destination: { queue_id: 'queue' }, events: ['instance.errored', 'instance.terminated', 'instance.completed'],
  }]);
  expect(log.mock.calls.flat()).toEqual(['unchanged messenger-economic-indicator-sync: instance.errored,instance.terminated,instance.completed']);
});
