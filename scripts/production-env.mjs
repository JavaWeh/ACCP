import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:Object.fromEntries(['directory','public-url','issuer','client-id','audience','admin-subject','admin-name','repository'].map(key=>[key,{type:'string'}]))});
for(const key of ['public-url','issuer','client-id','audience','admin-subject','repository'])if(!values[key])throw new Error(`--${key} is required`);
for(const key of ['public-url','issuer']){const u=new URL(values[key]);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||key==='public-url'&&u.pathname!=='/')throw new Error(`Invalid --${key}`)}
if(values['client-id']===values.audience)throw new Error('SPA client ID must differ from API audience');
for(const value of Object.values(values))if(/[\r\n\x00]/.test(value))throw new Error('Arguments must be single-line values');
const root=resolve(values.directory||'.accp-local/production');
if(existsSync(root))throw new Error('Refusing to overwrite an existing deployment directory');
mkdirSync(join(root,'secrets'),{recursive:true,mode:0o700});mkdirSync(join(root,'tls'),{mode:0o700});
// Parent directories are 0700; individual read-only bind mounts must also work for UID 65532.
const write=(path,value)=>writeFileSync(join(root,path),value,{encoding:'utf8',mode:path.startsWith('secrets/')||path==='tools.json'||path==='bootstrap.json'?0o444:0o600,flag:'wx'});
for(const role of ['operator','migrator','bootstrap','api','worker']){
 const password=randomBytes(32).toString('hex');write('secrets/'+role+'_password',password);
 if(role!=='operator')write('secrets/'+role+'_url',`postgres://accp_${role}:${password}@postgres:5432/accp?sslmode=disable`);
}
write('secrets/session_keys',JSON.stringify({active:'initial',keys:{initial:randomBytes(32).toString('hex')}}));
write('secrets/nats_token','nats_'+randomBytes(32).toString('hex'));
// An absent Git credential is valid when no GitHub tool is enabled.
write('secrets/github_token','');
write('tools.json',readFileSync('configs/tools.json','utf8'));
write('bootstrap.json',JSON.stringify({organization:{id:'org_initial',name:'Enterprise'},projects:[{id:'project_initial',name:'Initial project',repository:{id:'repo_initial',provider_id:'github',url:values.repository,default_branch:'main'}}],humans:[{id:'user_initial_admin',issuer:values.issuer,subject:values['admin-subject'],display_name:values['admin-name']||'Administrator',memberships:[{project_id:'project_initial',roles:['ADMIN']}]}]},null,2));
write('compose.env',Object.entries({ACCP_DEPLOY_DIR:root.replaceAll('\\','/'),ACCP_PUBLIC_URL:values['public-url'].replace(/\/$/,''),ACCP_OIDC_ISSUER:values.issuer,ACCP_OIDC_CLIENT_ID:values['client-id'],ACCP_OIDC_AUDIENCE:values.audience}).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');
console.log('Production configuration created. Install TLS certificate/key and review bootstrap.json before starting.');
