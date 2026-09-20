// Run only in the isolated acceptance network, with the fake IdP admin secret.
import {readFileSync} from 'node:fs';
const action=process.argv[2];
if(!['rotate-short-tokens','restore-token-lifetime'].includes(action))throw new Error('Expected isolated IdP lifecycle action');
const origin='http://keycloak:8080';
const password=readFileSync('/run/acceptance-admin','utf8').trim();
const auth=await fetch(origin+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'acceptance-admin',password}),signal:AbortSignal.timeout(15000)});
if(!auth.ok)throw new Error('Isolated IdP administrator authentication failed');
const {access_token}=await auth.json();
async function api(path,method='GET',body){const response=await fetch(origin+'/admin/realms/accp'+path,{method,headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Isolated IdP lifecycle request failed (${response.status})`);return response.status===204||response.status===201?undefined:response.json()}
if(action==='restore-token-lifetime'){await api('','PUT',{accessTokenLifespan:300});console.log(JSON.stringify({access_token_lifespan:300}));process.exit(0)}
const realm=await api('');
const before=await api('/keys');
const providers=await api('/components?type=org.keycloak.keys.KeyProvider');
const priority=Math.max(100,...providers.map(p=>Number(p.config?.priority?.[0])||0))+1;
await api('/components','POST',{name:'acceptance-rotation-'+Date.now(),providerId:'rsa-generated',providerType:'org.keycloak.keys.KeyProvider',parentId:realm.id,config:{priority:[String(priority)],enabled:['true'],active:['true'],keySize:['2048'],algorithm:['RS256']}});
const after=await api('/keys');
if(!after.active.RS256||before.active.RS256===after.active.RS256)throw new Error('IdP signing key did not rotate');
await api('','PUT',{accessTokenLifespan:15});
console.log(JSON.stringify({previous_kid:before.active.RS256,active_kid:after.active.RS256,access_token_lifespan:15}));
