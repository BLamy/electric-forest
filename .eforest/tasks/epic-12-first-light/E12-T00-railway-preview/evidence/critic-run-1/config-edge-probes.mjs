import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createPreviewRuntime } from './repo/packages/platform/dist/src/preview.js';
const w=import.meta.dirname, repo=resolve(w,'repo'),output=resolve(w,'edge-probes');await mkdir(output,{recursive:true});
const records=[];const temp=[];let runtime;
const dir=await mkdtemp(resolve(output,'data-'));temp.push(dir);
const env={EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_BUILD_REVISION:'49b46a180cfebe2e368b5611e668e8ed9c41fd25',EF_PUBLIC_ORIGIN:'http://127.0.0.1:9',EF_PREVIEW_DATA_DIR:dir,PORT:'0'};
const bakedPath=resolve(repo,'build-revision');let prior;
try{prior=await readFile(bakedPath);}catch(e){if(e.code!=='ENOENT')throw e;}
try {
 await writeFile(bakedPath,env.EF_BUILD_REVISION+'\n');
 await assert.rejects(createPreviewRuntime({...env,EF_BUILD_REVISION:'a'.repeat(40)}),/configured revision does not match/);
 runtime=await createPreviewRuntime({...env,EF_BUILD_REVISION:undefined});await runtime.start();
 const actual='http://127.0.0.1:'+runtime.server.address().port;
 const health=await (await fetch(actual+'/readyz')).json();assert.equal(health.revision,env.EF_BUILD_REVISION);
 records.push({name:'baked-revision-success-and-mismatch-refusal',observed:{revision:health.revision,mismatch:'refused'}});
 const login=await fetch(actual+'/auth/preview',{method:'POST',redirect:'manual',headers:{origin:env.EF_PUBLIC_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:'subject=ada'});assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const prefix=await (await fetch(actual+'/api/chat/preview/welcome?projection=1&reducer=chat-channel',{headers:{cookie}})).json();
 const controller=new AbortController();const follow=fetch(actual+'/api/chat/preview/welcome?projection=1&reducer=chat-channel&live=1&checkpoint='+prefix.checkpoint+'&waitMs=1500',{headers:{cookie},signal:controller.signal}).then(r=>r.text()).catch(e=>e.name);
 await new Promise(r=>setTimeout(r,40));const start=performance.now();await runtime.close();runtime=undefined;const elapsed=Math.round(performance.now()-start);assert.ok(elapsed<60000);controller.abort();const result=await follow;
 records.push({name:'shutdown-with-live-projection-reader',observed:{shutdownMs:elapsed,readerResult:result}});
 for(const [name,contents] of [['invalid-json','{not-json'],['wrong-version',JSON.stringify({version:2,fixture:'railway-first-light-v1',bootstrap:'ready',sessionSecret:'c'.repeat(64)})],['short-secret',JSON.stringify({version:1,fixture:'railway-first-light-v1',bootstrap:'ready',sessionSecret:'short'})],['missing-marker',undefined]]) {
  const data=await mkdtemp(resolve(output,name+'-'));temp.push(data);
  await writeFile(resolve(data,contents===undefined?'orphan':'preview-state.json'),contents??'orphan');await assert.rejects(createPreviewRuntime({...env,EF_PREVIEW_DATA_DIR:data}));records.push({name:'volume-'+name,observed:'refused without reseed'});
 }
 const canary='edge-canary-'+randomUUID();const refused=[];
 for(const key of ['EFOREST_SERVER_URL','EF_RESEND_API_KEY','CODEX_HOME']) {
  const child=spawnSync(process.execPath,[resolve(repo,'packages/platform/dist/src/preview-bin.js')],{cwd:repo,env:{PATH:process.env.PATH,...env,[key]:canary},encoding:'utf8'});assert.equal(child.status,1);const text=child.stdout+child.stderr;assert.ok(!text.includes(canary));assert.match(text,/preview forbids/);refused.push({key,exit:child.status,stdout:child.stdout,stderr:child.stderr});
 }
 records.push({name:'real-entrypoint-rejects-inherited-config-without-printing-canary',observed:{canarySha256:createHash('sha256').update(canary).digest('hex'),cases:refused}});
 await writeFile(resolve(w,'config-edge-review.json'),JSON.stringify({records},null,2)+'\n');console.log(JSON.stringify({ok:true,records}));
} finally {
 await runtime?.close();if(prior===undefined)await rm(bakedPath,{force:true});else await writeFile(bakedPath,prior);for(const path of temp)await rm(path,{recursive:true,force:true});
}
