import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{directory:{type:'string'},'env-file':{type:'string'},project:{type:'string'},overlay:{type:'string'},actor:{type:'string'},output:{type:'string'},isolated:{type:'boolean'}}});
if(!values.isolated||!/^accp-(product|acceptance)[a-z0-9_-]*$/.test(values.project||'')||!values.output)throw new Error('Explicit isolated acceptance project and output required');
const common=['scripts/rotate-production.mjs','--directory',values.directory,'--env-file',values['env-file'],'--project',values.project,'--actor',values.actor,'--reason','Isolated interruption and resume drill','--kind','session'];
if(values.overlay)common.push('--overlay',values.overlay);
const prepared=spawnSync(process.execPath,[...common,'--phase','prepare'],{encoding:'utf8',windowsHide:true});if(prepared.status!==0)throw new Error('Rotation preparation failed');
const {operation}=JSON.parse(prepared.stdout);
const args=[...common,'--phase','apply','--operation',operation];
const child=spawn(process.execPath,args,{stdio:'ignore',windowsHide:true});
let interrupted=false;
const timer=setInterval(()=>{
 try{const state=JSON.parse(readFileSync(join(values.directory,'rotations',operation,'state.json'),'utf8'));if(state.step==='RESTARTED'&&!interrupted){interrupted=true;child.kill('SIGTERM')}}catch{}
},50);
const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});clearInterval(timer);clearTimeout(timeout);
if(!interrupted)throw new Error('Did not reach the intended interruption boundary');
const resumed=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});
const report={operation,interrupted_at:'RESTARTED',resumed:resumed.status===0};writeFileSync(values.output,JSON.stringify(report,null,2));
if(resumed.status!==0)throw new Error('Resume failed; keep maintenance active and inspect this operation UUID');
console.log(JSON.stringify(report));
