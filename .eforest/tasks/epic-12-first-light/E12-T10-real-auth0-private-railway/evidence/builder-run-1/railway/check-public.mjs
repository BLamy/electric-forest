import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const origin='https://electric-forest-production.up.railway.app';
const revision=process.argv[2];
const destination=resolve(process.argv[3]);
assert.match(revision,/^[a-f0-9]{40}$/);
await mkdir(destination,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const results=[];
for(const path of ['/healthz','/readyz','/api/build','/api/deployment']) {
  const start=performance.now();
  const response=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,path);
  const body=await response.json();
  assert.equal(body.revision,revision,path);
  assert.equal(body.mode,'production'); assert.equal(body.auth,'auth0');
  assert.equal(body.data,'private'); assert.equal(body.agents,'off'); assert.equal(body.integrations,'off');
  assert.deepEqual(body.limits,{maxBodyBytes:8388608,requestDeadlineMs:30000,readinessMs:60000,drainMs:15000,transactionTtlMs:600000,sessionTtlSeconds:86400,maxLongPollMs:10000,http:{headersTimeout:30000,requestTimeout:30000,connectionsCheckingInterval:1000,keepAliveTimeout:5000}});
  results.push({path,status:response.status,elapsedMs:Math.round(performance.now()-start),body});
}
const deployment=results.find(x=>x.path==='/api/deployment').body;
assert.equal(deployment.artifact.digest,sha(JSON.stringify(deployment.artifact.files)));
assert.equal(deployment.artifact.revision,revision);
const landingResponse=await fetch(origin+'/',{redirect:'manual',signal:AbortSignal.timeout(15000)});
assert.equal(landingResponse.status,200);
const landingHTML=await landingResponse.text();
assert.ok(landingHTML.includes(revision));
const entryPaths=[...new Set([...landingHTML.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match=>match[1]))];
assert.ok(entryPaths.some(path=>path.endsWith('.js')));
assert.ok(entryPaths.some(path=>path.endsWith('.css')));
const assets=[];
for(const path of entryPaths) {
  const file=deployment.artifact.files.find(item=>item.path==='apps/web/dist'+path);
  assert.ok(file,path);
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,path);
  const bytes=new Uint8Array(await response.arrayBuffer());
  assert.equal(sha(bytes),file.sha256,path); assert.equal(bytes.length,file.size,path);
  assets.push({path,status:response.status,sha256:sha(bytes),size:bytes.length});
}
const login=await fetch(origin+'/auth/login?next=%2Fsettings%2Fcli-tokens',{redirect:'manual',signal:AbortSignal.timeout(15000)});
assert.equal(login.status,302);
const authorization=new URL(login.headers.get('location'));
assert.equal(authorization.origin,'https://dev-8qqftel4x1s5wed3.us.auth0.com');
assert.equal(authorization.pathname,'/authorize');
assert.equal(authorization.searchParams.get('client_id'),'H9LGwHMzwWHgamCot9KTAmOFJCmDIlOk');
assert.equal(authorization.searchParams.get('redirect_uri'),origin+'/auth/callback');
assert.equal(authorization.searchParams.get('response_type'),'code');
assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
assert.equal(login.headers.get('referrer-policy'),'no-referrer');
const cookies=login.headers.getSetCookie().map(raw=>{
  assert.match(raw,/; Secure/); assert.match(raw,/; HttpOnly/); assert.match(raw,/; SameSite=Lax/);
  return {name:raw.split('=')[0],secure:true,httpOnly:true,sameSite:'Lax',path:/; Path=([^;]+)/.exec(raw)?.[1],valueRetained:false};
});
assert.equal(cookies.length,2);
const refusals=[];
for(const path of ['/streams/__identity__','/admin','/auth/preview','/__proof/e3-t02']) {
 const response=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,404,path); refusals.push({path,status:response.status});
}
const anonymous=await fetch(origin+'/api/whoami',{redirect:'manual',signal:AbortSignal.timeout(15000)});
assert.equal(anonymous.status,401);
refusals.push({path:'/api/whoami',status:401,responseBodyRetained:false});
const receipt={recordedAt:new Date().toISOString(),origin,sourceRevision:revision,results,assets,assetScope:'initial HTML entry assets; full runtime artifact digest independently checked above',login:{status:302,issuerOrigin:authorization.origin,authorizationPath:authorization.pathname,clientId:authorization.searchParams.get('client_id'),redirectUri:authorization.searchParams.get('redirect_uri'),responseType:'code',codeChallengeMethod:'S256',scope:authorization.searchParams.get('scope'),referrerPolicy:'no-referrer',cookies,stateAndNonceAndChallengeRetained:false,actualOperatorLogin:false},refusals};
await writeFile(resolve(destination,'public.json'),JSON.stringify(receipt,null,2)+'\n');
process.stdout.write(JSON.stringify({revision,artifactDigest:deployment.artifact.digest,assetCount:assets.length,health:'passed',loginRedirect:'passed',privateRoutes:'passed'})+'\n');
