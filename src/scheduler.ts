import type { Bindings } from './contracts';

const targets = ['INGEST_SCHEDULE', 'DASHBOARD_SCHEDULE', 'DATA_SCHEDULE', 'QUANT_SCHEDULE'] as const;
export type ScheduleTarget = typeof targets[number];

/** Cloudflare Cron expressions use UTC. Match the original planned minute. */
export function dueTargets(scheduledTime: number): ScheduleTarget[] {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || scheduledTime % 60_000 !== 0
    || !Number.isFinite(new Date(scheduledTime).getTime())) throw new Error('Invalid scheduled time');
  const date = new Date(scheduledTime);
  const hour = date.getUTCHours(), minute = date.getUTCMinutes();
  const weekday = date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
  return targets.filter(target => {
    switch (target) {
      case 'INGEST_SCHEDULE': return weekday && hour < 10 && minute % 5 === 0;
      case 'DASHBOARD_SCHEDULE': return weekday && hour === 9 && minute === 0;
      case 'DATA_SCHEDULE': return hour === 16 && minute === 0;
      case 'QUANT_SCHEDULE': return weekday && hour === 0 && minute === 30;
    }
  });
}

export async function settleScheduledJobs(jobs: { name: string; run: () => Promise<unknown> }[], scheduledTime: number) {
  const results = await Promise.allSettled(jobs.map(async job => job.run()));
  const failed: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const task = jobs[index]!.name;
      failed.push(task);
      console.error(JSON.stringify({ event: 'scheduled_task_failed', task, scheduledTime,
        errorType: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        ...(result.reason instanceof ScheduleDispatchError ? { httpStatus: result.reason.httpStatus } : {}),
      }));
    }
  }
  if (failed.length) throw new Error(`Scheduled tasks failed: ${failed.join(', ')}`);
}

export async function dispatchScheduledTasks(env: Bindings, scheduledTime: number): Promise<void> {
  await settleScheduledJobs(dueTargets(scheduledTime).map(target => ({
    name: target,
    async run() {
      const binding = env[target];
      if (!binding) throw new Error(`Missing ${target} binding`);
      const response = await binding.fetch(new Request(`https://scheduler.internal/scheduled?scheduledTime=${scheduledTime}`, {
        method: 'POST', signal: AbortSignal.timeout(120_000),
      }));
      await response.body?.cancel();
      if (!response.ok) throw new ScheduleDispatchError(response.status);
      console.log(JSON.stringify({ event: 'scheduled_task_completed', task: target, scheduledTime }));
    },
  })), scheduledTime);
}

class ScheduleDispatchError extends Error {
  override name = 'ScheduleDispatchError';
  constructor(readonly httpStatus: number) { super(`Scheduled task HTTP ${httpStatus}`); }
}
