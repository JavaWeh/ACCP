import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const {values}=parseArgs({options:{project:{type:'string'},prometheus:{type:'string'},output:{type:'string'},isolated:{type:'boolean'}}});
if(!values.isolated||!/^accp-[a-z0-9_-]+$/.test(values.project||'')||!values.output)throw new Error('Explicit isolated ACCP project and output required');
const endpoint=new URL(values.prometheus||'http://127.0.0.1:19090');
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost'].includes(endpoint.hostname))throw new Error('Fault drill requires a loopback Prometheus endpoint');
const docker=(...args)=>{const p=spawnSync('docker',args,{encoding:'utf8',windowsHide:true});if(p.status!==0)throw new Error('Isolated container action failed')};
const alerts=async()=>{const r=await fetch(new URL('/api/v1/alerts',endpoint),{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('Prometheus unavailable');return (await r.json()).data.alerts};
const waitFor=async(name,firing,limit)=>{const start=Date.now();while(Date.now()-start<limit){const found=(await alerts()).some(a=>a.labels.alertname===name&&a.state==='firing');if(found===firing)return (Date.now()-start)/1000;await new Promise(resolve=>setTimeout(resolve,5000))}throw new Error(`Alert ${name} did not ${firing?'fire':'clear'} within deadline`)};
const results=[];
try{
 for(const [service,alert]of [['worker','ACCPWorkerStalled'],['nats','ACCPWorkerStalled'],['postgres','ACCPUnavailable']]){
  const container=`${values.project}-${service}-1`;
  await waitFor(alert,false,120000);console.log(`Injecting isolated ${service} outage`);
  docker('stop',container);
  try{const seconds=await waitFor(alert,true,150000);results.push({service,alert,fired_seconds:seconds});}
  finally{docker('start',container)}
  const clear=await waitFor(alert,false,150000);results.at(-1).cleared_seconds=clear;console.log(`${service} alert fired and cleared`);
 }
 writeFileSync(values.output,JSON.stringify({passed:true,at:new Date().toISOString(),results},null,2));
}catch(error){writeFileSync(values.output,JSON.stringify({passed:false,at:new Date().toISOString(),results,error:String(error)},null,2));throw error}
