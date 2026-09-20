import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,chmodSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';

const {values}=parseArgs({options:Object.fromEntries(['directory','env-file','project','actor','reason','kind','operation','phase','overlay'].map(name=>[name,{type:'string'}]))});
for(const name of ['directory','env-file','project','actor','reason','kind','phase'])if(!values[name])throw new Error(`--${name} required`);
if(!['database','nats','session'].includes(values.kind)||!['prepare','apply','status'].includes(values.phase))throw new Error('Invalid rotation kind or phase');
if(!/^[a-z0-9][a-z0-9_-]+$/.test(values.project))throw new Error('Invalid Compose project');
const root=resolve(values.directory),operation=values.operation||randomUUID();
if(!/^[a-f0-9-]{36}$/.test(operation))throw new Error('Use the operation UUID returned by prepare');
const stage=join(root,'rotations',operation),stateFile=join(stage,'state.json');
const compose=['compose','--env-file',resolve(values['env-file']),'-p',values.project,'-f',resolve('deploy/production/compose.yaml')];
if(values.overlay)compose.push('-f',resolve(values.overlay));
const run=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});if(r.status!==0)throw new Error('Rotation command failed; installation remains in maintenance; resume this operation UUID');return r.stdout.trim()};
const write=(path,data)=>{if(existsSync(path))chmodSync(path,0o600);writeFileSync(path,data,{mode:0o600});chmodSync(path,0o444)};
if(values.phase==='prepare'){
 if(existsSync(stage))throw new Error('Rotation operation already exists');mkdirSync(stage,{recursive:true,mode:0o700});
 const replacements={};
 if(values.kind==='database')for(const role of ['api','worker','bootstrap','migrator','operator']){
  const password=randomBytes(32).toString('hex');replacements[role+'_password']=password;
  if(role!=='operator'){const url=new URL(readFileSync(join(root,'secrets',role+'_url'),'utf8').trim());url.password=password;replacements[role+'_url']=url.href;}
 }
 if(values.kind==='nats')replacements.nats_token='nats_'+randomBytes(32).toString('hex');
 if(values.kind==='session'){
  const ring=JSON.parse(readFileSync(join(root,'secrets/session_keys'),'utf8'));if(Object.keys(ring.keys).length>=8)throw new Error('Retire a no-longer-valid verification key before adding a ninth key');
  const key='k'+randomBytes(8).toString('hex');ring.keys[key]=randomBytes(32).toString('hex');ring.active=key;replacements.session_keys=JSON.stringify(ring);
 }
 for(const [name,value]of Object.entries(replacements)){write(join(stage,name+'.old'),readFileSync(join(root,'secrets',name)));write(join(stage,name+'.new'),value)}
 const state={operation,kind:values.kind,project:values.project,actor:values.actor,reason:values.reason,files:Object.keys(replacements),step:'PREPARED',at:new Date().toISOString()};writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});
 console.log(JSON.stringify({operation,phase:'PREPARED',next:'apply with the same operation UUID'}));
}else{
 const state=JSON.parse(readFileSync(stateFile,'utf8'));
 if(state.project!==values.project||state.kind!==values.kind||state.actor!==values.actor)throw new Error('Rotation operation identity does not match');
 if(values.phase==='status'){console.log(JSON.stringify({operation,phase:state.step,kind:state.kind}));process.exit(0)}
 const record=step=>{state.step=step;state.at=new Date().toISOString();writeFileSync(stateFile+'.next',JSON.stringify(state,null,2),{mode:0o600});renameSync(stateFile+'.next',stateFile)};
 if(state.step==='SUCCEEDED'){console.log(JSON.stringify({operation,phase:state.step}));process.exit(0)}
 // Local maintenance uses the migrator account, whose URL is mounted separately.
 if(state.step==='PREPARED'){
  run([...compose,'run','--rm','--no-deps','-e','DATABASE_URL_FILE=/run/secrets/migrator_url','-v',`${join(root,'secrets/migrator_url')}:/run/secrets/migrator_url:ro`,'doctor','maintenance','--action','enter','--actor',state.actor,'--reason',`${operation}: ${state.reason}`]);record('MAINTENANCE');
 }else{
  const container=run([...compose,'ps','-q','postgres']);if(!/^[a-f0-9]{12,64}$/.test(container))throw new Error('Expected exactly one PostgreSQL container');
  const gate=run(['exec',container,'psql','-U','accp_operator','-d','accp','-Atc',"SELECT maintenance FROM accp.runtime_state WHERE id='default'"]);
  if(gate!=='t')throw new Error('Interrupted rotation requires maintenance; enter it before resuming');
 }
 run([...compose,'stop','api','worker']);record('STOPPED');
 if(state.kind==='database'){
  const container=run([...compose,'ps','-q','postgres']);if(!/^[a-f0-9]{12,64}$/.test(container))throw new Error('Expected exactly one PostgreSQL container');
  const statements=['BEGIN;'];for(const role of ['api','worker','bootstrap','migrator','operator']){const password=readFileSync(join(stage,role+'_password.new'),'utf8');if(!/^[a-f0-9]{64}$/.test(password))throw new Error('Invalid staged password');statements.push(`ALTER ROLE accp_${role} PASSWORD '${password}';`)}statements.push('COMMIT;');
  run(['exec','-i',container,'psql','-U','accp_operator','-d','accp','-v','ON_ERROR_STOP=1'],statements.join('\n'));record('DATABASE_UPDATED');
 }
 for(const name of state.files)write(join(root,'secrets',name),readFileSync(join(stage,name+'.new')));record('FILES_UPDATED');
 if(state.kind==='nats')run([...compose,'up','-d','--no-deps','--force-recreate','nats']);
 run([...compose,'up','-d','--no-deps','--force-recreate','api','worker']);record('RESTARTED');
 // Keep the gate closed until all checks succeed. Re-running apply reuses staged keys.
 let verified=false;
 for(let attempt=0;attempt<12;attempt++){
  try{run([...compose,'run','--rm','--no-deps','doctor']);verified=true;break}catch{await new Promise(resolve=>setTimeout(resolve,5000))}
 }
 if(!verified)throw new Error('Doctor did not become healthy; maintenance remains active. Resume this operation after diagnosing.');record('VERIFIED');
 run([...compose,'run','--rm','--no-deps','-e','DATABASE_URL_FILE=/run/secrets/migrator_url','-v',`${join(root,'secrets/migrator_url')}:/run/secrets/migrator_url:ro`,'doctor','maintenance','--action','leave','--actor',state.actor,'--reason',`${operation}: rotation verified`]);record('SUCCEEDED');
 console.log(JSON.stringify({operation,phase:state.step}));
}
