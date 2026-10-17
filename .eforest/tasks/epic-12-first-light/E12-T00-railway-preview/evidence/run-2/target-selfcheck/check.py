from pathlib import Path
import subprocess, os, json, re, time, hashlib, datetime
root=Path.cwd()
work=Path(__file__).resolve().parent
repo=work/'repo'
expected='1f9e06b87109a93c75107842d4c8aa65902f8622'
def git(*args,cwd=root):
    return subprocess.check_output(['git',*args],cwd=cwd,text=True).strip()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
assert not repo.exists(), 'Never reuse a warmed checkout'
receipt={'kind':'builder pristine target-only self-validation; not registered critic cold clone','source':expected,'startedAt':now(),'commands':[]}
subprocess.run(['git','clone','--no-local','--quiet',str(root),str(repo)],check=True)
subprocess.run(['git','checkout','--detach',expected],cwd=repo,check=True,capture_output=True)
assert git('rev-parse','HEAD',cwd=repo)==expected
initial=[str(p.relative_to(repo)) for p in [repo/'node_modules',repo/'apps/web/dist',*repo.glob('packages/*/dist'),*repo.rglob('*.tsbuildinfo')] if p.exists()]
assert initial==[],initial
receipt['initialWorkspaceOutputs']=initial
receipt['initialTrackedStatus']=git('status','--porcelain=v1','--untracked-files=no',cwd=repo)
assert receipt['initialTrackedStatus']==''
store=None
for line in (root/'node_modules/.modules.yaml').read_text().splitlines():
    if line.startswith('storeDir: '): store=line[10:].strip()
assert store and Path(store).is_absolute() and (Path(store)/'files').is_dir() and (Path(store)/'index').is_dir()
env={k:v for k,v in os.environ.items() if k not in ['NODE_OPTIONS','NODE_ENV','BASH_ENV','ENV','GNUMAKEFLAGS','MFLAGS'] and not k.startswith(('MAKE','CARGO_','EF_','EFOREST_','AUTH0_','CLAUDE_')) and not k.lower().startswith('npm_config_') and not k.endswith('_OS_SANDBOX_ACTIVE')}
env['CI']='true'
receipt['scrubbedVariableNames']=sorted(set(os.environ)-set(env))
receipt['storeReuse']='content-addressed pnpm files/index only; independent frozen installation'
def save(): (work/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
for name,cmd in [('install',['pnpm','install','--frozen-lockfile','--store-dir',store]),('target',['make','--','verify-E12-T00'])]:
    item={'name':name,'argv':cmd,'startedAt':now(),'log':name+'.log'}
    receipt['commands'].append(item);save();print('START '+name,flush=True)
    started=time.monotonic()
    with (work/(name+'.log')).open('wb') as out:
        result=subprocess.run(cmd,cwd=repo,env=env,stdout=out,stderr=subprocess.STDOUT)
    data=(work/(name+'.log')).read_bytes()
    item.update({'exitCode':result.returncode,'elapsedSeconds':round(time.monotonic()-started,3),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'endedAt':now()});save();print('END '+name+' exit='+str(result.returncode),flush=True)
    if result.returncode: raise SystemExit(result.returncode)
receipt['finalSource']=git('rev-parse','HEAD',cwd=repo)
receipt['finalTrackedStatus']=git('status','--porcelain=v1','--untracked-files=no',cwd=repo)
assert receipt['finalSource']==expected and receipt['finalTrackedStatus']==''
log=(work/'target.log').read_text()
assert 'verify-E12-T00: OK' in log
assert '18 passed' in log
receipt['status']='passed';receipt['endedAt']=now();save()
print('PASS exact target without prior root build',flush=True)
