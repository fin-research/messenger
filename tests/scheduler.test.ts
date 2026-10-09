import { expect, it, vi } from 'vitest';
import { dueTargets, dispatchScheduledTasks, settleScheduledJobs } from '../src/scheduler';
import type { Bindings } from '../src/contracts';

it.each([
 ['2026-10-09T00:00:00Z', ['INGEST_SCHEDULE']],
 ['2026-10-09T00:30:00Z', ['INGEST_SCHEDULE','QUANT_SCHEDULE']],
 ['2026-10-09T09:00:00Z', ['INGEST_SCHEDULE','DASHBOARD_SCHEDULE']],
 ['2026-10-09T09:55:00Z', ['INGEST_SCHEDULE']],
 ['2026-10-09T10:00:00Z', []],
 ['2026-10-09T00:01:00Z', []],
 ['2026-10-09T16:00:00Z', ['DATA_SCHEDULE']],
 ['2026-10-10T00:30:00Z', []],
 ['2026-10-10T09:00:00Z', []],
 ['2026-10-10T16:00:00Z', ['DATA_SCHEDULE']],
])('matches original UTC slots: %s', (time, expected) => {
 expect(dueTargets(Date.parse(time))).toEqual(expected);
});
it.each([NaN,0,1,Infinity,1.1])('rejects invalid slots: %s', time => expect(() => dueTargets(time)).toThrow());
it('dispatches every due target, awaits them, and preserves the planned timestamp on repeats', async () => {
 const time=Date.parse('2026-10-09T00:30:00Z');
 const requests: Request[]=[];
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const env={ INGEST_SCHEDULE:{fetch:vi.fn(async (request:Request)=>{requests.push(request);await gate;return new Response(null,{status:204});})},
 QUANT_SCHEDULE:{fetch:vi.fn(async (request:Request)=>{requests.push(request);return new Response(null,{status:204});})} };
 let done=false;
 const pending=dispatchScheduledTasks(env as unknown as Bindings,time).then(()=>{done=true;});
 await Promise.resolve();await Promise.resolve();
 expect(env.QUANT_SCHEDULE.fetch).toHaveBeenCalledTimes(1);expect(done).toBe(false);
 release();await pending;
 await dispatchScheduledTasks(env as unknown as Bindings,time);
 expect(requests).toHaveLength(4);
 for(const request of requests){expect(request.method).toBe('POST');expect(new URL(request.url).searchParams.get('scheduledTime')).toBe(String(time));}
});
it('one HTTP failure still dispatches other due jobs and surfaces failure',async()=>{
 const ok=vi.fn(async()=>new Response(null,{status:204}));
 const env={INGEST_SCHEDULE:{fetch:async()=>new Response(null,{status:503})},QUANT_SCHEDULE:{fetch:ok}};
 await expect(dispatchScheduledTasks(env as unknown as Bindings,Date.parse('2026-10-09T00:30:00Z'))).rejects.toThrow('INGEST_SCHEDULE');
 expect(ok).toHaveBeenCalledTimes(1);
});
it('migration/recovery failure cannot block dispatch or notification scan',async()=>{
 const dispatched=vi.fn(async()=>undefined), scanned=vi.fn(async()=>undefined);
 await expect(settleScheduledJobs([{name:'migration',run:async()=>{throw Error('failed');}},{name:'dispatch',run:dispatched},{name:'scan',run:scanned}],Date.parse('2026-10-09T09:00:00Z'))).rejects.toThrow('migration');
 expect(dispatched).toHaveBeenCalledTimes(1);expect(scanned).toHaveBeenCalledTimes(1);
});
