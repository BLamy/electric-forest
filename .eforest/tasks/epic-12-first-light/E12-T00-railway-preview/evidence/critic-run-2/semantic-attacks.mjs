import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createPreviewRuntime,readPreviewEnvironment} from './repo/packages/platform/dist/src/preview.js';
import {canonicalJson,stateDigest} from './repo/packages/protocol/dist/src/index.js';
import {chatChannelInitialState,chatChannelReducer} from './repo/packages/reducers/dist/src/index.js';
const out=resolve(import.meta.dirname,'semantic');await mkdir(out,{recursive:true});
const directory=await mkdtemp(resolve(out,'data-'));const separate=await mkdtemp(resolve(out,'separate-'));const partial=await mkdtemp(resolve(out,'partial-'));
const env={EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_BUILD_REVISION:'a7e861d023651925a16e9103c0f50fce9c368a4e',EF_PUBLIC_ORIGIN:'http://127.0.0.1:9',EF_PREVIEW_DATA_DIR:directory,PORT:'0'};
const nonce=randomBytes(8).toString('hex');const secret='EF_CRITIC_R2_CANARY_'+nonce;const records=[];let runtime;
const record=(name,result)=>{records.push({name,...result});console.log(name,JSON.stringify(result));};
const start=async(config)=>{const t=performance.now();const r=await createPreviewRuntime(config);await r.start();assert.ok(performance.now()-t<60000);return r;};
const response=async(path,init={})=>{const r=await fetch(`http://127.0.0.1:${runtime.server.address().port}${path}`,{redirect:'manual',...init});const text=await r.text();assert.ok(!text.includes(secret));return {status:r.status,text,location:r.headers.get('location'),cookie:r.headers.get('set-cookie')};};
const login=async(subject='ada',next='/chat/preview/welcome')=>response('/auth/preview',{method:'POST',headers:{origin:env.EF_PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({subject,next})});
const dump=async(cookie)=>{const r=await response('/api/chat/preview/welcome?projection=1&reducer=chat-channel',{headers:{cookie}});assert.equal(r.status,200);return JSON.parse(r.text);};
try {
 for(const key of ['EFOREST_SERVER_URL','EF_OIDC_ISSUER','EF_OIDC_CLIENT_ID','EF_SESSION_SECRET','EF_RESEND_API_KEY','EF_RESEND_URL','EF_RESEND_FROM','EF_AGENT_CMD','AUTH0_CLIENT_SECRET','OIDC_CLIENT_SECRET','RESEND_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','CLAUDE_CONFIG_DIR','CODEX_HOME','AWS_SECRET_ACCESS_KEY','GH_TOKEN','GITHUB_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','DURABLE_STREAMS_URL','ELECTRIC_URL','NODE_OPTIONS','NODE_PATH','SSH_AUTH_SOCK','GIT_ASKPASS']) {
  const value=/URL|ISSUER/.test(key)?'https://prod.critic.invalid/'+secret:secret;let message;
  assert.throws(()=>readPreviewEnvironment({...env,[key]:value}),e=>{message=e.message;return !message.includes(secret)});
  await assert.rejects(createPreviewRuntime({...env,[key]:value}));record('config-refusal',{key,message});
 }
 for(const value of ['harness','local','stub','OFF','']) {assert.throws(()=>readPreviewEnvironment({...env,EF_AGENT_RESPONDER:value}));record('agent-config-refusal',{value});}
 assert.deepEqual(await (await import('node:fs/promises')).readdir(directory),[],'invalid config must not bootstrap data');
 await mkdir(resolve(out,'bad-assets'),{recursive:true});await writeFile(resolve(out,'bad-assets/index.html'),'<html><head><script type="module" src="/assets/missing-r2.js"></script></head></html>');
 await assert.rejects(createPreviewRuntime({...env,EF_WEB_ROOT:resolve(out,'bad-assets')}));record('missing-script-assets',{refused:true});
 await writeFile(resolve(partial,'orphan-stream-data'),nonce);await assert.rejects(createPreviewRuntime({...env,EF_PREVIEW_DATA_DIR:partial}),/bootstrap marker/);record('orphan-volume',{refused:true});
 runtime=await start(env);const firstLogin=await login();assert.equal(firstLogin.status,303);const cookie=firstLogin.cookie.split(';')[0];let before=await dump(cookie);const stateSecret=JSON.parse(await readFile(resolve(directory,'preview-state.json'),'utf8')).sessionSecret;
 for(const path of ['/streams/__identity__','/streams/ns%3Aroot','/streams/chat%3Apreview%2Fwelcome','/admin','/__admin','/.env','/.git/config'])for(const method of ['GET','POST','DELETE']) {
  const r=await response(path,{method,headers:{origin:env.EF_PUBLIC_ORIGIN,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({canary:secret})})});assert.equal(r.status,404);assert.ok(!r.text.includes(stateSecret));record('raw-private',{path,method,status:r.status});
 }
 for(const path of ['/%73treams/__identity__','/streams%2f__identity__','/api/streams/__identity__','//streams/__identity__','/streams/../.env']) {
  const r=await response(path);assert.ok([302,401,403,404].includes(r.status));assert.ok(!r.text.includes(stateSecret));record('encoded-route',{path,status:r.status});
 }
 for(const path of ['/api/cli-tokens','/api/cli-tokens/new','/settings/cli-tokens','/api/device-grants']) {const r=await response(path,{headers:{cookie}});assert.equal(r.status,403);record('external-integrations',{path,status:r.status});}
 const blocked=await response('/api/dispatch',{method:'POST',headers:{cookie,origin:env.EF_PUBLIC_ORIGIN,'content-type':'application/json'},body:JSON.stringify({streamId:'agents:preview',event:{type:'agent.register',payload:{nonce},ts:1}})});assert.equal(blocked.status,403);record('agent-dispatch',{status:blocked.status});
 for(const subject of ['root','__proto__','Ada','preview|ada']){const r=await login(subject);assert.equal(r.status,400);record('invalid-fixture-subject',{subject,status:r.status});}
 for(const next of ['//evil.critic.invalid','https://evil.critic.invalid','/\\evil.critic.invalid','/x?next=//evil.critic.invalid']){const r=await login('grace',next);assert.equal(r.status,303);assert.equal(r.location,'/preview/forest');record('redirect-refusal',{next,location:r.location});}
 const csrf=await response('/auth/preview',{method:'POST',headers:{origin:'https://other.critic.invalid','content-type':'application/x-www-form-urlencoded'},body:'subject=ada'});assert.equal(csrf.status,403);record('cross-origin',{status:csrf.status});
 assert.deepEqual((await dump(cookie)).events,before.events);
 const payload={streamId:'chat:preview/welcome',event:{type:'chat.message.post',payload:{v:1,id:'r2-'+nonce,body:'Fresh critic run 2 '+nonce},ts:1820000000123}};
 const posted=await response('/api/dispatch',{method:'POST',headers:{cookie,origin:env.EF_PUBLIC_ORIGIN,'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(posted.status,202);
 const grace=(await login('grace')).cookie.split(';')[0];const accepted=await dump(grace);assert.equal(accepted.events.length,before.events.length+1);assert.equal(accepted.events.at(-1).payload.body,payload.event.payload.body);const digest=stateDigest(accepted.events.reduce(chatChannelReducer,chatChannelInitialState));await writeFile(resolve(out,'accepted.jsonl'),accepted.events.map(canonicalJson).join('\n')+'\n');
 const marker=await readFile(resolve(directory,'preview-state.json'),'utf8');const oldPort=runtime.server.address().port;let t=performance.now();await runtime.close();assert.ok(performance.now()-t<60000);runtime=await start(env);const restored=await dump(cookie);assert.deepEqual(restored.events,accepted.events);assert.equal(stateDigest(restored.events.reduce(chatChannelReducer,chatChannelInitialState)),digest);assert.equal(await readFile(resolve(directory,'preview-state.json'),'utf8'),marker);record('fresh-write-restart',{nonce,eventCount:accepted.events.length,offset:accepted.checkpoint,digest,oldPort,newPort:runtime.server.address().port});
 const second=await start({...env,EF_PREVIEW_DATA_DIR:separate});try {const raw=await(await fetch(`${second.streamUrl}/streams/chat%3Apreview%2Fwelcome?offset=-1`)).text();assert.ok(!raw.includes(nonce));record('separate-directory',{containsFreshWrite:false});}finally{await second.close();}
 // Novel destructive diagnostic is confined to disposable storage: ready marker plus a missing required stream must refuse, never reseed.
 const deleted=await fetch(`${runtime.streamUrl}/streams/ns%3Aorg%3Apreview`,{method:'DELETE'});assert.ok(deleted.ok);await runtime.close();runtime=undefined;await assert.rejects(createPreviewRuntime(env),/incomplete; refusing to reseed/);assert.equal(await readFile(resolve(directory,'preview-state.json'),'utf8'),marker);record('missing-required-ready-stream',{refused:true,markerUnchanged:true});
 const summary={seed:nonce,canarySha256:createHash('sha256').update(secret).digest('hex'),records};await writeFile(resolve(out,'results.json'),JSON.stringify(summary,null,2)+'\n');console.log('SEMANTIC_ATTACKS_OK');
}finally{await runtime?.close();await Promise.all([directory,separate,partial].map(path=>rm(path,{recursive:true,force:true})));}
