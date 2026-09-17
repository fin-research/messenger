// Plan by default. Credentials are only supplied through the process environment.
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const token = process.env.CLOUDFLARE_API_TOKEN;
if(!token) throw new Error('CLOUDFLARE_API_TOKEN required (Queues Write and Workers Scripts Read)');
const root=`https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
async function api(path,method='GET',body){
  const response=await fetch(root+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok || !result.success) throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}`);
  return result;
}
async function list(path){
  const results=[];
  for(let page=1;;page++){
    const value=await api(`${path}?page=${page}&per_page=100`);
    results.push(...value.result);
    if(value.result.length<100 || page >= (value.result_info?.total_pages ?? Infinity)) return results;
  }
}
const [workflows,queues,subscriptions]=await Promise.all([list('/workflows'),list('/queues'),list('/event_subscriptions/subscriptions')]);
const configured=new Set(config.workflows.map(x=>x.name));
const missing=workflows.filter(x=>!configured.has(x.name));
if(missing.length) throw new Error(`Add cross-script bindings and workflowBindings entries first: ${missing.map(x=>x.name).join(', ')}`);
const queue=queues.find(x=>x.queue_name==='messenger-workflow-events');
if(!queue) throw new Error('Create messenger-workflow-events and messenger-workflow-events-dlq queues first');
for(const workflow of workflows){
  const events=['instance.errored','instance.terminated'];
  if(['omo','market-briefing','economic-indicator-sync'].includes(workflow.name)) events.push('instance.completed');
  const name=`messenger-${workflow.name}`;
  const body={name,enabled:true,source:{type:'workflows.workflow',workflow_name:workflow.name},destination:{type:'queues.queue',queue_id:queue.queue_id},events};
  const current=subscriptions.find(x=>x.name===name);
  if(current && (current.source?.type!=='workflows.workflow' || current.source?.workflow_name!==workflow.name)) throw new Error(`Subscription ${name} has a different source; inspect and recreate explicitly`);
  const equal=current?.enabled && current.source?.workflow_name===workflow.name && current.destination?.queue_id===queue.queue_id && JSON.stringify([...current.events].sort())===JSON.stringify([...events].sort());
  console.log(`${equal?'unchanged':current?'update':'create'} ${name}: ${events.join(',')}`);
  if(!equal && process.argv.includes('--apply')) {
    const {source,...update}=body;
    await api('/event_subscriptions/subscriptions'+(current?`/${current.id}`:''),current?'PATCH':'POST',current?update:body);
  }
}
