import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {createPreviewRuntime} from './repo/packages/platform/dist/src/preview.js';
import {canonicalJson} from './repo/packages/protocol/dist/src/index.js';
const repo=resolve(import.meta.dirname,'repo');const require=createRequire(resolve(repo,'package.json'));const {chromium}=require('playwright-core');
const output=resolve(process.argv[2]);await mkdir(output,{recursive:true});const data=await mkdtemp(resolve(output,'data-'));
const reserve=createServer();await new Promise(done=>reserve.listen(0,'127.0.0.1',done));const port=reserve.address().port;await new Promise(done=>reserve.close(done));const origin=`http://127.0.0.1:${port}`;
const runtime=await createPreviewRuntime({EF_DEPLOYMENT_MODE:'preview',EF_PREVIEW_AUTH:'fixture',EF_PUBLIC_ORIGIN:origin,EF_BUILD_REVISION:'a7e861d023651925a16e9103c0f50fce9c368a4e',EF_PREVIEW_DATA_DIR:data,PORT:String(port)});await runtime.start();
let browser;const errors=[],network=[],records=[];const seed=randomBytes(8).toString('hex');
const log=(name,result)=>{records.push({name,...result});console.log(name,JSON.stringify(result));};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.AGENT_BROWSER_EXECUTABLE_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const contexts=await Promise.all([browser.newContext(),browser.newContext()]);const pages=await Promise.all(contexts.map(c=>c.newPage()));
 for(let i=0;i<2;i++) {
  const page=pages[i];page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>network.push({profile:i,url:r.url(),status:r.status(),method:r.request().method(),...(r.url().endsWith('/api/dispatch')?{body:r.request().postData()}:{} )}));
  await page.goto(origin+'/chat/preview/welcome');await page.getByTestId('preview-notice').waitFor();await page.getByTestId(i===0?'preview-login-ada':'preview-login-grace').click();await page.getByTestId('chat-channel').waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid="chat-channel"]')?.getAttribute('data-stream-status')==='live');
 }
 const snapshot=async(stage)=>{
  const res=await contexts[0].request.get(origin+'/api/chat/preview/welcome?projection=1&reducer=chat-channel');assert.equal(res.status(),200);const prefix=await res.json();const path=resolve(output,stage+'.jsonl');await writeFile(path,prefix.events.map(canonicalJson).join('\n')+'\n');const digest=execFileSync(process.execPath,[resolve(repo,'packages/cli/dist/src/bin.js'),'replay',path,'--digest','--reducer','chat-channel'],{cwd:repo,encoding:'utf8'}).trim();return {prefix,digest};
 };
 let initial=await snapshot('initial');for(const p of pages)assert.equal(await p.getByTestId('chat-channel').getAttribute('data-ef-digest'),initial.digest);log('initial-frozen-value-valid',{digest:initial.digest,eventCount:initial.prefix.events.length});
 const witnessNavigation=network.filter(n=>n.profile===1&&n.url===origin+'/chat/preview/welcome').length;const text='Critic own pointer keyboard seed '+seed;const composer=pages[0].getByTestId('chat-composer').locator('[contenteditable="true"]');await composer.click();await composer.fill(text);await pages[0].getByTestId('chat-send').click();await pages[1].getByTestId('chat-message').filter({hasText:text}).waitFor();
 const accepted=await snapshot('accepted');assert.equal(accepted.prefix.events.length,initial.prefix.events.length+1);assert.equal(accepted.prefix.events.filter(e=>e.payload.body===text).length,1);const dispatch=network.filter(n=>n.url===origin+'/api/dispatch'&&n.method==='POST');assert.ok(dispatch.some(n=>n.status===202));log('real-write-accepted-and-witness-visible',{seed,acceptedDigest:accepted.digest,offset:accepted.prefix.checkpoint,dispatchStatuses:dispatch.map(n=>n.status),domDigests:await Promise.all(pages.map(p=>p.getByTestId('chat-channel').getAttribute('data-ef-digest')))});
 assert.equal(network.filter(n=>n.profile===1&&n.url===origin+'/chat/preview/welcome').length,witnessNavigation,'witness did not reload');
 for(const p of pages){await p.waitForFunction(({expected})=>document.querySelector('[data-testid="chat-channel"]')?.getAttribute('data-ef-digest')===expected,{expected:accepted.digest},{timeout:5000});assert.equal(await p.getByTestId('chat-channel').getAttribute('data-ef-offset'),accepted.prefix.checkpoint);}
 await pages[1].close();const text2=text+' offline';await composer.click();await composer.fill(text2);await composer.press('Enter');await pages[0].getByTestId('chat-message').filter({hasText:text2}).waitFor();pages[1]=await contexts[1].newPage();await pages[1].goto(origin+'/chat/preview/welcome');await pages[1].getByTestId('chat-message').filter({hasText:text2}).waitFor();const final=await snapshot('reconnected');for(const p of pages)await p.waitForFunction(({expected})=>document.querySelector('[data-testid="chat-channel"]')?.getAttribute('data-ef-digest')===expected,{expected:final.digest},{timeout:5000});assert.deepEqual(errors,[]);log('reconnected-canonical-convergence',{digest:final.digest,offset:final.prefix.checkpoint,eventCount:final.prefix.events.length,errors});await writeFile(resolve(output,'results.json'),JSON.stringify({origin,seed,records,network,errors},null,2)+'\n');console.log('FRESH_BROWSER_SENSOR_OK');
}catch(error){await writeFile(resolve(output,'failure.json'),JSON.stringify({message:error.message,records,network,errors},null,2)+'\n');throw error;}finally{await browser?.close();await runtime.close();await rm(data,{recursive:true,force:true});}
