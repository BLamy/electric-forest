import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createPreviewRuntime, readPreviewEnvironment } from './repo/packages/platform/dist/src/preview.js';
import { readPlatformEnvironment } from './repo/packages/platform/dist/src/production.js';
import { chatChannelInitialState, chatChannelReducer } from './repo/packages/reducers/dist/src/index.js';
import { canonicalJson, stateDigest } from './repo/packages/protocol/dist/src/index.js';
import { OfficialStreamAdapter } from './repo/packages/platform/dist/src/official.js';
const output=resolve(import.meta.dirname,'semantic-attacks'); await mkdir(output,{recursive:true});
const runtimeDirs=[]; const records=[]; let active;
const revision='49b46a180cfebe2e368b5611e668e8ed9c41fd25';
const dataDir=await mkdtemp(resolve(output,'data-'));runtimeDirs.push(dataDir);
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const origin=`http://127.0.0.1:${port}`;
const env={EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_BUILD_REVISION:revision,EF_PUBLIC_ORIGIN:origin,EF_PREVIEW_DATA_DIR:dataDir,PORT:String(port)};
const canary='critic-canary-'+randomUUID(); const canaryHash=createHash('sha256').update(canary).digest('hex');
const record=(name,observed)=>{records.push({name,observed});};
const login=async(subject,next='/chat/preview/welcome',requestedOrigin=origin)=>{
 const r=await fetch(origin+'/auth/preview',{method:'POST',redirect:'manual',headers:{origin:requestedOrigin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({subject,next})});
 return {response:r,cookie:r.headers.get('set-cookie')?.split(';')[0]};
};
const dump=async(cookie)=>{
 const r=await fetch(origin+'/api/chat/preview/welcome?projection=1&reducer=chat-channel',{headers:{cookie}});assert.equal(r.status,200);return await r.json();
};
const post=async(cookie,id,body)=>{
 const value={streamId:'chat:preview/welcome',event:{type:'chat.message.post',payload:{v:1,id,body},ts:Date.now()}};
 const r=await fetch(origin+'/api/dispatch',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(value)}); assert.equal(r.status,202,await r.clone().text());return value;
};
try{
 const baseProduction={EF_OIDC_ISSUER:'https://identity.example.invalid',EF_OIDC_CLIENT_ID:'critic-valid-shape',EF_SESSION_SECRET:'critic-non-production-shape',EF_SESSION_TTL:'3600',EFOREST_SERVER_URL:'http://127.0.0.1:9'};
 for(const [key,value] of [['EF_DEPLOYMENT_MODE','preview'],['EF_PREVIEW_AUTH','fixture'],['EF_PREVIEW_DATA_DIR',dataDir]]){
  assert.throws(()=>readPlatformEnvironment({...baseProduction,[key]:value}),/preview configuration/);
 }record('production-entrypoint-refuses-valid-shaped-preview-configuration',3);
 const denied=[['EFOREST_SERVER_URL','https://production.example.invalid'],['EF_OIDC_ISSUER','https://idp.example.invalid'],['EF_OIDC_CLIENT_ID',canary],['EF_SESSION_SECRET',canary],['EF_RESEND_URL','https://mail.example.invalid'],['EF_RESEND_API_KEY',canary],['EF_AGENT_RESPONDER','harness'],['OPENAI_API_KEY',canary],['ANTHROPIC_AUTH_TOKEN',canary],['CODEX_HOME','/synthetic-auth-home'],['CLAUDE_CONFIG_DIR','/synthetic-claude'],['AWS_SECRET_ACCESS_KEY',canary],['GOOGLE_APPLICATION_CREDENTIALS','/synthetic-google.json'],['SSH_AUTH_SOCK','/synthetic-sock'],['GH_TOKEN',canary],['DURABLE_STREAM_AUTH',canary],['NODE_OPTIONS','--import=/synthetic'],['NODE_PATH','/synthetic']];
 for(const [name,value] of denied){
  const dir=resolve(output,'refused-'+name); const input={...env,EF_PREVIEW_DATA_DIR:dir,[name]:value};
  let error;try{readPreviewEnvironment(input);}catch(e){error=e;}assert.ok(error instanceof Error,name);assert.ok(!error.message.includes(canary));
  await assert.rejects(createPreviewRuntime(input));await assert.rejects(readFile(resolve(dir,'preview-state.json')));
 }record('unsafe-config-refused-before-disk-or-socket',denied.map(([name])=>name));
 const bads=[{PORT:'-1'},{PORT:'65536'},{PORT:'NaN'},{EF_PREVIEW_AUTH:'oidc'},{EF_DEPLOYMENT_MODE:'production'},{EF_BUILD_REVISION:'not-a-commit'},{EF_PUBLIC_ORIGIN:'http://public.example.invalid'},{EF_PUBLIC_ORIGIN:'https://user:pass@public.example.invalid'},{EF_PUBLIC_ORIGIN:'https://public.example.invalid/path'},{EF_PREVIEW_DATA_DIR:'relative-data'},{EF_WEB_ROOT:'relative-assets'}];
 for(const bad of bads)assert.throws(()=>readPreviewEnvironment({...env,...bad}));record('malformed-config-refusal',bads.length);
 const missing=resolve(output,'missing-assets');await assert.rejects(createPreviewRuntime({...env,EF_WEB_ROOT:missing}));
 const noJS=resolve(output,'html-without-js');await mkdir(noJS,{recursive:true});await writeFile(resolve(noJS,'index.html'),'<html><head></head><body></body></html>');await assert.rejects(createPreviewRuntime({...env,EF_WEB_ROOT:noJS}),/requires built/);record('missing-built-assets',2);
 const start=performance.now();active=await createPreviewRuntime(env);await active.start();const startupMs=Math.round(performance.now()-start);assert.ok(startupMs<60000);assert.equal(active.server.address().address,'0.0.0.0');assert.equal(new URL(active.streamUrl).hostname,'127.0.0.1');
 for(const path of ['/healthz','/readyz','/api/build']){const r=await fetch(origin+path);assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes(canary));assert.doesNotMatch(text,/sessionSecret|__fixture_identity_disabled/);const b=JSON.parse(text);assert.equal(b.mode,'preview');assert.equal(b.revision,revision);assert.equal(b.agents,'off');}
 const external=Object.values(networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal);assert.ok(external,'need real network interface for public-bind sensitivity');
 const viaInterface=await fetch(`http://${external.address}:${port}/healthz`,{signal:AbortSignal.timeout(3000)});assert.equal(viaInterface.status,200);record('all-interface-ingress-and-private-stream',{'listener':active.server.address().address,'externalInterfaceAddress':external.address,'status':viaInterface.status,startupMs});
 const raw=[];for(const path of ['/streams/__identity__','/streams/ns%3Aroot','/streams/raw-critic','/admin','/__admin','/.env','/.git/config'])for(const method of ['GET','POST']){const r=await fetch(origin+path,{method,redirect:'manual',headers:{origin,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({canary})}:{})});assert.equal(r.status,404);const text=await r.text();assert.ok(!text.includes(canary));raw.push({path,method,status:r.status});}record('public-raw-endpoints-refused',raw);
 for(const subject of ['root','preview|ada','admin'])assert.equal((await login(subject)).response.status,400);assert.equal((await login('ada','/chat/preview/welcome','https://attacker.example.invalid')).response.status,403);
 const ada=await login('ada','//attacker.example.invalid');assert.equal(ada.response.status,303);assert.equal(ada.response.headers.get('location'),'/preview/forest');const grace=await login('grace');assert.equal(grace.response.status,303);assert.notEqual(ada.cookie,grace.cookie);
 const cookie=ada.cookie;record('fixture-selection-origin-and-redirect-boundary',{wrongSubjects:3,foreignOrigin:403,openRedirect:'clamped',distinctSignedSessions:true});
 const before=await dump(cookie);const ownBody='critic own seed '+randomUUID();const firstId='critic-'+randomUUID();await post(cookie,firstId,ownBody);
 const a=await dump(cookie);const b=await dump(grace.cookie);assert.equal(canonicalJson(a.events),canonicalJson(b.events));assert.equal(a.events.length,before.events.length+1);assert.equal(a.events.filter(x=>x.payload.id===firstId).length,1);
 const firstDigest=stateDigest(a.events.reduce(chatChannelReducer,chatChannelInitialState));assert.equal(firstDigest,stateDigest(b.events.reduce(chatChannelReducer,chatChannelInitialState)));
 const secondId='critic-'+randomUUID();await post(cookie,secondId,'critic disconnected witness '+randomUUID());const reconnected=await dump(grace.cookie);assert.equal(reconnected.events.length,a.events.length+1);assert.equal(reconnected.events.filter(x=>x.payload.id===secondId).length,1);record('two-independent-HTTP-clients-canonical-convergence',{beforeEvents:before.events.length,afterEvents:reconnected.events.length,firstDigest});
 const malformed=['{','null','[]','{"streamId":"chat:preview/welcome","event":{"type":0}}','{"streamId":"chat:preview/welcome","event":{"type":"agent.register","payload":null,"ts":0}}'];
 const fuzz=[];for(const body of malformed){const r=await fetch(origin+'/api/dispatch',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body});assert.ok(r.status>=400&&r.status<500,`malformed request had status ${r.status}`);const text=await r.text();assert.ok(!text.includes(canary));fuzz.push(r.status);}record('novel-malformed-dispatch-refuses-without-500',fuzz);
 const integrations=[];for(const path of ['/api/cli-tokens','/api/device-grants','/settings/cli-tokens']){const r=await fetch(origin+path,{headers:{cookie}});assert.equal(r.status,403);integrations.push({path,status:r.status});}
 const agent=await fetch(origin+'/api/dispatch',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({streamId:'agents:preview',event:{type:'agent.register',payload:{v:1},ts:1}})});assert.equal(agent.status,403);assert.equal((await fetch(origin+'/auth/callback?state=x&code=y')).status,404);record('agent-and-real-integration-routes',integrations);
 const seedBefore=await readFile(resolve(dataDir,'preview-state.json'));const accepted=await dump(cookie);const stopping=performance.now();await active.close();active=undefined;const shutdownMs=Math.round(performance.now()-stopping);assert.ok(shutdownMs<60000);
 const restart=performance.now();active=await createPreviewRuntime(env);await active.start();const restartMs=Math.round(performance.now()-restart);assert.ok(restartMs<60000);const restored=await dump(cookie);assert.equal(canonicalJson(restored.events),canonicalJson(accepted.events));assert.equal(stateDigest(restored.events.reduce(chatChannelReducer,chatChannelInitialState)),stateDigest(accepted.events.reduce(chatChannelReducer,chatChannelInitialState)));assert.equal((await readFile(resolve(dataDir,'preview-state.json'))).compare(seedBefore),0);assert.equal(restored.events.filter(x=>x.payload.id==='preview-welcome').length,1);
 await writeFile(resolve(output,'fresh-accepted.jsonl'),restored.events.map(canonicalJson).join('\n')+'\n');record('same-directory-bootstrap-and-session-restart',{shutdownMs,restartMs,offset:restored.checkpoint,digest:stateDigest(restored.events.reduce(chatChannelReducer,chatChannelInitialState)),events:restored.events.length,oneWelcome:true});
 const other=await mkdtemp(resolve(output,'other-'));runtimeDirs.push(other);const separate=await createPreviewRuntime({...env,PORT:'0',EF_PREVIEW_DATA_DIR:other});try{await separate.start();const text=await (await fetch(separate.streamUrl+'/streams/chat%3Apreview%2Fwelcome?offset=-1')).text();assert.ok(!text.includes(ownBody));record('distinct-directory-isolation',true);}finally{await separate.close();}
 const adapter=new OfficialStreamAdapter({baseUrl:active.streamUrl});assert.equal(await adapter.delete('chat:preview/welcome'),true);await active.close();active=undefined;await assert.rejects(createPreviewRuntime(env),/incomplete; refusing to reseed/);assert.equal((await readFile(resolve(dataDir,'preview-state.json'))).compare(seedBefore),0);record('novel-ready-marker-with-missing-stream-refuses-reseed',true);
 const partial=await mkdtemp(resolve(output,'partial-'));runtimeDirs.push(partial);await writeFile(resolve(partial,'preview-state.json'),JSON.stringify({version:1,fixture:'railway-first-light-v1',bootstrap:'initializing',sessionSecret:'b'.repeat(64)}));await assert.rejects(createPreviewRuntime({...env,EF_PREVIEW_DATA_DIR:partial}),/bootstrap is incomplete/);record('interrupted-bootstrap-refuses-silent-reseed',true);
 const result={candidate:revision,canarySha256:canaryHash,records};await writeFile(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:true,records:records.map(x=>x.name),canarySha256:canaryHash}));
}finally{await active?.close();for(const dir of runtimeDirs)await rm(dir,{recursive:true,force:true});}
