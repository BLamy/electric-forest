import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {networkInterfaces} from 'node:os';
import {createPreviewRuntime} from './repo/packages/platform/dist/src/preview.js';
import {readPlatformEnvironment} from './repo/packages/platform/dist/src/production.js';
if(process.argv[2]==='config') {
 const complete={EF_OIDC_ISSUER:'https://r2-identity.critic.invalid',EF_OIDC_CLIENT_ID:'run-2-complete-shape',EF_SESSION_SECRET:'r2-complete-production-shaped-secret',EF_SESSION_TTL:'3600',EFOREST_SERVER_URL:'http://127.0.0.1:7'};
 assert.doesNotThrow(()=>readPlatformEnvironment(complete),'complete control config is accepted without preview flag');
 for(const flag of [{EF_PREVIEW_AUTH:'fixture'},{EF_DEPLOYMENT_MODE:'preview'},{EF_PREVIEW_DATA_DIR:'/tmp/critic-r2-fixture'}])assert.throws(()=>readPlatformEnvironment({...complete,...flag}),/preview configuration/,'complete production shape must fail closed under each preview flag');
 console.log('COMPLETE_SHAPE_PRODUCTION_GUARD_SENSOR_OK');
} else {
 const directory=await mkdtemp(resolve(import.meta.dirname,'network-data-'));let runtime;
 try{
  runtime=await createPreviewRuntime({EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_BUILD_REVISION:'a7e861d023651925a16e9103c0f50fce9c368a4e',EF_PUBLIC_ORIGIN:'http://127.0.0.1:7',EF_PREVIEW_DATA_DIR:directory,PORT:'0'});await runtime.start();const port=runtime.server.address().port;
  const addr=Object.values(networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal)?.address;assert.ok(addr,'real nonloopback interface required');
  const local=await fetch(`http://127.0.0.1:${port}/readyz`);assert.equal(local.status,200);console.log(JSON.stringify({listener:runtime.server.address().address,loopback:local.status,ingressInterface:addr,port}));
  const ingress=await fetch(`http://${addr}:${port}/readyz`,{signal:AbortSignal.timeout(2500)});assert.equal(ingress.status,200);assert.equal(runtime.server.address().address,'0.0.0.0');console.log('REAL_INGRESS_SENSOR_OK');
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
}
