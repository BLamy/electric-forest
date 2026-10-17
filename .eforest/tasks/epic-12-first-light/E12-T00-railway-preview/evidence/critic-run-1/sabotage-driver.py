from pathlib import Path
import subprocess,json,time,os,hashlib,sys
w=Path(__file__).resolve().parent;repo=w/'repo';out=w/'sensitivity';out.mkdir(exist_ok=True)
commands=[];sabotages=[]
def sha(data):return hashlib.sha256(data).hexdigest()
def run(name,cmd,expected=0,cwd=repo):
 path=out/(name+'.log');start=time.time()
 with path.open('w') as log: p=subprocess.run(cmd,cwd=cwd,env={**os.environ,'CI':'true'},stdout=log,stderr=subprocess.STDOUT,timeout=150)
 result={'name':name,'command':cmd,'cwd':str(cwd),'exitCode':p.returncode,'expected':'nonzero' if expected=='nonzero' else expected,'seconds':round(time.time()-start,3),'log':str(path),'bytes':path.stat().st_size,'sha256':sha(path.read_bytes())}
 commands.append(result);(out/'commands.json').write_text(json.dumps(commands,indent=2)+'\n');print(json.dumps(result),flush=True)
 if expected=='nonzero':assert p.returncode!=0,(name,'mutation survived')
 else:assert p.returncode==expected,(name,p.returncode)
 return result
http=['node','tools/verify/e12_t00_preview.mjs']
browser=['node','tools/verify/e12_t00_browser.mjs','local']
unit=['pnpm','exec','vitest','run','--maxWorkers=1','packages/platform/test/preview.test.ts']
# Baselines are sensitivity surfaces, not replacement final hosted evidence.
run('baseline-http',http+[str(out/'http-baseline')])
run('baseline-config-tests',unit)
run('baseline-config-sensor',['node',str(w/'sensitivity-sensor.mjs'),'config'])
run('baseline-network-sensor',['node',str(w/'sensitivity-sensor.mjs'),'network'])
run('baseline-browser',browser+[str(out/'browser-baseline')])

path=repo/'packages/platform/src/preview.ts';original=path.read_bytes();source=original.decode();old='listenPlatformServer(server, config.port, "0.0.0.0")';new='listenPlatformServer(server, config.port, "127.0.0.1")';assert source.count(old)==1
try:
 path.write_text(source.replace(old,new));run('bind-mutated-build',['pnpm','--filter','@eforest/platform','build'])
 network=run('bind-mutant-real-network',['node',str(w/'sensitivity-sensor.mjs'),'network'],'nonzero')
 assertion=run('bind-mutant-builder-http',http+[str(out/'http-bind-mutant')],'nonzero')
 assert '127.0.0.1' in Path(assertion['log']).read_text() and '0.0.0.0' in Path(assertion['log']).read_text()
 sabotages.append({'id':'S1','behavior':'public listener binding','source':'packages/platform/src/preview.ts','mutation':old+' -> '+new,'sourceBaselineSha256':sha(original),'realNetworkAssertion':network,'builderAssertion':assertion,'detected':True})
finally:
 path.write_bytes(original);run('bind-restored-build',['pnpm','--filter','@eforest/platform','build']);run('bind-restored-real-network',['node',str(w/'sensitivity-sensor.mjs'),'network'])
 assert path.read_bytes()==original
(out/'sabotages.json').write_text(json.dumps(sabotages,indent=2)+'\n')

path=repo/'packages/platform/src/production.ts';original=path.read_bytes();source=original.decode();guard='''  if (
    environment.EF_DEPLOYMENT_MODE === "preview" ||
    environment.EF_PREVIEW_AUTH !== undefined ||
    environment.EF_PREVIEW_DATA_DIR !== undefined
  ) {
    throw new Error("preview configuration requires the explicit preview entrypoint");
  }
''';assert source.count(guard)==1
try:
 path.write_text(source.replace(guard,''));run('guard-mutated-build',['pnpm','--filter','@eforest/platform','build'])
 sensor=run('guard-mutant-complete-prod-fields',['node',str(w/'sensitivity-sensor.mjs'),'config'],'nonzero')
 assertion=run('guard-mutant-builder-tests',unit+['-t','keeps production entrypoint closed to preview identity'],'nonzero')
 assert 'Missing expected exception' in Path(sensor['log']).read_text()
 sabotages.append({'id':'S2','behavior':'production preview-identity guard','source':'packages/platform/src/production.ts','mutation':'delete complete preview-refusal guard','sourceBaselineSha256':sha(original),'completeProductionShapeSensor':sensor,'builderAssertion':assertion,'detected':True})
finally:
 path.write_bytes(original);run('guard-restored-build',['pnpm','--filter','@eforest/platform','build']);run('guard-restored-complete-prod-fields',['node',str(w/'sensitivity-sensor.mjs'),'config'])
 assert path.read_bytes()==original
(out/'sabotages.json').write_text(json.dumps(sabotages,indent=2)+'\n')

path=repo/'apps/web/src/chat/ChatChannelPage.tsx';original=path.read_bytes();source=original.decode();old='data-ef-digest={binding.projection.digest}';new='data-ef-digest={"0".repeat(64)}';assert source.count(old)==1
try:
 path.write_text(source.replace(old,new));run('digest-mutated-build',['pnpm','--filter','@eforest/web','build'])
 assertion=run('digest-mutant-builder-browser',browser+[str(out/'browser-digest-mutant')],'nonzero')
 failure=json.loads((out/'browser-digest-mutant/failure.json').read_text());assert 'waitForFunction: Timeout' in failure['message']
 assert any(n['path']=='/api/dispatch' and n['status']==202 for n in failure['network'])
 assert any(t['name']=='seeded-file-browsed' for t in failure['timeline'])
 sabotages.append({'id':'S3','behavior':'DOM digest agrees with independent replay','source':'apps/web/src/chat/ChatChannelPage.tsx:108','mutation':old+' -> '+new,'sourceBaselineSha256':sha(original),'builderAssertion':assertion,'failurePath':str(out/'browser-digest-mutant/failure.json'),'failure':failure['message'],'gatewayAcceptedBeforeDetection':True,'detected':True})
finally:
 path.write_bytes(original);run('digest-restored-build',['pnpm','--filter','@eforest/web','build'])
 assert path.read_bytes()==original
run('restored-browser',browser+[str(out/'browser-restored')])
run('restored-config-tests',unit)
(out/'sabotages.json').write_text(json.dumps(sabotages,indent=2)+'\n')
status=subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True);assert status=='',status
(out/'complete.json').write_text(json.dumps({'commands':commands,'sabotages':sabotages,'trackedStatusAfterRestoration':status,'allThreeDetected':len(sabotages)==3 and all(s['detected'] for s in sabotages)},indent=2)+'\n')
print('SENSITIVITY_COMPLETE',flush=True)
