import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createPreviewRuntime } from './repo/packages/platform/dist/src/preview.js';
import { readPlatformEnvironment } from './repo/packages/platform/dist/src/production.js';
if(process.argv[2]==='config') {
 const input={EF_OIDC_ISSUER:'https://critic-idp.example.invalid',EF_OIDC_CLIENT_ID:'critic-shape',EF_SESSION_SECRET:'critic-local-shape',EF_SESSION_TTL:'3600',EFOREST_SERVER_URL:'http://127.0.0.1:9',EF_PREVIEW_AUTH:'fixture'};
 assert.throws(()=>readPlatformEnvironment(input),/preview configuration/, 'production startup must refuse preview auth even with complete production fields');
 console.log('CONFIG_GUARD_SENSOR_OK');
} else {
 const directory=await mkdtemp(resolve(import.meta.dirname,'sensitivity/network-data-'));let runtime;
 try {
 runtime=await createPreviewRuntime({EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_BUILD_REVISION:'49b46a180cfebe2e368b5611e668e8ed9c41fd25',EF_PUBLIC_ORIGIN:'http://127.0.0.1:9',EF_PREVIEW_DATA_DIR:directory,PORT:'0'});
 await runtime.start(); const port=runtime.server.address().port;
 const own=Object.values(networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal);assert.ok(own,'network-interface sensor requires an external self-interface');
 const loopback=await fetch('http://127.0.0.1:'+port+'/healthz');assert.equal(loopback.status,200);
 console.log(JSON.stringify({listener:runtime.server.address().address,loopback:loopback.status,interface:own.address,port}));
 const ingress=await fetch('http://'+own.address+':'+port+'/healthz',{signal:AbortSignal.timeout(3000)});assert.equal(ingress.status,200,'assigned ingress interface must reach preview');
 assert.equal(runtime.server.address().address,'0.0.0.0');
 console.log('PUBLIC_BIND_REAL_NETWORK_SENSOR_OK');
 } finally {await runtime?.close();await rm(directory,{recursive:true,force:true});}
}
