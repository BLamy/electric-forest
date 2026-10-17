from pathlib import Path
import subprocess,json,time,os,hashlib
out=Path(__file__).resolve().parent;repo=out/'repo';logs=out/'sensitivity';logs.mkdir(exist_ok=True)
env={k:v for k,v in os.environ.items() if k not in {'NODE_OPTIONS','NODE_ENV','BASH_ENV','ENV','GNUMAKEFLAGS','MFLAGS'} and not k.startswith('MAKE') and not k.lower().startswith('npm_config_')};env['CI']='true';receipts=[];mutations=[]
def run(name,cmd,expected=0):
 t=time.monotonic()
 with (logs/(name+'.log')).open('w') as f:p=subprocess.run(cmd,cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=180)
 r={'name':name,'command':cmd,'cwd':str(repo),'exit':p.returncode,'seconds':round(time.monotonic()-t,3),'log':name+'.log','logSha256':hashlib.sha256((logs/(name+'.log')).read_bytes()).hexdigest()};receipts.append(r);(logs/'commands.json').write_text(json.dumps(receipts,indent=2)+'\n');print(json.dumps(r),flush=True)
 assert (p.returncode!=0) if expected=='red' else (p.returncode==expected),(name,p.returncode)
 return r
platform=['pnpm','--filter','@eforest/platform','build'];web=['pnpm','--filter','@eforest/web','build']
preview=repo/'packages/platform/src/preview.ts';production=repo/'packages/platform/src/production.ts';chat=repo/'apps/web/src/chat/ChatChannelPage.tsx'
seed=json.loads((out/'sensor-baseline-browser/results.json').read_text())['records'][0]['digest'];assert seed=='c7e483ecf4d927730b99ef540724204b6816c09555c33b4650f86787f2ab3b19'
guard='''  if (
    environment.EF_DEPLOYMENT_MODE === "preview" ||
    environment.EF_PREVIEW_AUTH !== undefined ||
    environment.EF_PREVIEW_DATA_DIR !== undefined
  ) {
    throw new Error("preview configuration requires the explicit preview entrypoint");
  }
'''
cases=[
 ('bind',preview,'start: () => listenPlatformServer(server, config.port, "0.0.0.0")','start: () => listenPlatformServer(server, config.port, "127.0.0.1")',platform,[('real-ingress',['node',str(out/'network-config-sensor.mjs'),'network']),('builder-http',['node','tools/verify/e12_t00_preview.mjs',str(logs/'bind-builder-http-output')])]),
 ('guard',production,guard,'',platform,[('complete-shape',['node',str(out/'network-config-sensor.mjs'),'config']),('builder-config',['pnpm','exec','vitest','run','--maxWorkers=1','packages/platform/test/preview.test.ts'])]),
 ('digest',chat,'data-ef-digest={binding.projection.digest}','data-ef-digest={"'+seed+'"}',web,[('accepted-write-browser',['node',str(out/'fresh-browser-sensor.mjs'),str(logs/'digest-mutant-own-browser')]),('builder-browser',['node','tools/verify/e12_t00_browser.mjs','local',str(logs/'digest-mutant-builder-browser')])])
]
for name,path,old,new,build,checks in cases:
 original=path.read_text();assert original.count(old)==1;before=hashlib.sha256(original.encode()).hexdigest();record={'name':name,'file':str(path.relative_to(repo)),'originalSha256':before,'mutation':'single isolated textual replacement; no patch/diff body persisted','baselineReceipts':['../baseline-commands.json','../sensor-baselines.json']}
 try:
  path.write_text(original.replace(old,new,1));record['mutatedSha256']=hashlib.sha256(path.read_bytes()).hexdigest();record['mutatedTrackedPaths']=subprocess.check_output(['git','diff','--name-only'],cwd=repo,text=True).splitlines();run(name+'-mutated-build',build)
  record['red']=[run(name+'-mutant-'+label,cmd,'red') for label,cmd in checks]
 finally:
  path.write_text(original);record['restoredSha256']=hashlib.sha256(path.read_bytes()).hexdigest();assert record['restoredSha256']==before;run(name+'-restored-build',build)
  record['green']=[run(name+'-restored-'+label,([*cmd[:-1],str(logs/'digest-restored-own-browser')] if name=='digest' and label=='accepted-write-browser' else [*cmd[:-1],str(logs/'digest-restored-builder-browser')] if name=='digest' and label=='builder-browser' else cmd)) for label,cmd in checks]
  record['trackedStatusAfterRestore']=subprocess.check_output(['git','status','--short','--untracked-files=no'],cwd=repo,text=True);assert record['trackedStatusAfterRestore']==''
 mutations.append(record);(logs/'complete.json').write_text(json.dumps({'mutations':mutations,'commands':receipts},indent=2)+'\n')
print('THREE_DISTINCT_SABOTAGES_RED_RESTORED_GREEN',flush=True)
