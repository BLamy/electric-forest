from pathlib import Path
import subprocess,datetime,json,time,hashlib,sys
root=Path.cwd();work=Path(__file__).resolve().parent;task=work.parent
expected='1f9e06b87109a93c75107842d4c8aa65902f8622'
def git(*args): return subprocess.check_output(['git',*args],text=True,cwd=root).strip()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt={'source':expected,'startedAt':now(),'commands':[],'phase':'post-audit final recorded evidence'}
assert git('rev-parse','HEAD')==expected and git('status','--porcelain=v1','--untracked-files=no')==''
audit=json.loads((task/'run-2-gate-audit/manifest.json').read_text());assert audit['status']=='passed';assert audit['candidate_oid']==expected
commands=[('http',['node','tools/verify/e12_t00_preview.mjs',str(task/'run-2-http')]),('hosted-before',['node','tools/verify/e12_t00_browser.mjs','https://electric-forest-preview-production.up.railway.app',str(task/'run-2-hosted-before')]),('hosted-supplement',['node',str(task/'hosted-supplement.mjs'),'https://electric-forest-preview-production.up.railway.app',expected,str(task/'run-2-hosted-supplement')])]
for name,cmd in commands:
 item={'name':name,'command':cmd,'startedAt':now(),'log':name+'.log'};receipt['commands'].append(item)
 (work/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print('START '+name,flush=True)
 t=time.monotonic()
 with (work/(name+'.log')).open('wb') as log: result=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT)
 data=(work/(name+'.log')).read_bytes();item.update({'exitCode':result.returncode,'elapsedSeconds':round(time.monotonic()-t,3),'sha256':hashlib.sha256(data).hexdigest(),'endedAt':now()})
 (work/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print('END '+name+' exit='+str(result.returncode),flush=True)
 if result.returncode:sys.exit(result.returncode)
assert git('rev-parse','HEAD')==expected and git('status','--porcelain=v1','--untracked-files=no')==''
receipt.update({'status':'passed','endedAt':now(),'finalSource':git('rev-parse','HEAD')});(work/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
