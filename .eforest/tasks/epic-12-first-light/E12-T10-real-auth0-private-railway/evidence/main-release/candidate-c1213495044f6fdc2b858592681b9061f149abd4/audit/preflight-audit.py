#!/usr/bin/env python3
import pathlib, os, subprocess, datetime, time, json, hashlib
ROOT=pathlib.Path('/Users/blamy/Documents/Codex/electric-forest')
OUT=ROOT/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/main-release/audit-c1213495'
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,data): path.write_text(json.dumps(data,indent=2,sort_keys=True)+'\n')
if (OUT/'preflight-assessment.json').exists(): raise RuntimeError('preflight already complete')
removed=sorted(k for k in os.environ if k.upper() in ('NODE_OPTIONS','NODE_ENV') or k.lower().startswith('npm_config_'))
env={k:v for k,v in os.environ.items() if k not in removed}
env['GIT_OPTIONAL_LOCKS']='0'
def run(name,argv,cwd=ROOT,binary=False):
 start=utc(); mono=time.monotonic_ns()
 stdout=OUT/(name+('.bin' if binary else '.stdout.log')); stderr=OUT/(name+'.stderr.log')
 with stdout.open('xb') as sout, stderr.open('xb') as serr:
  proc=subprocess.run(argv,cwd=cwd,env=env,stdout=sout,stderr=serr)
 return {'command':argv,'cwd':str(cwd),'utcStart':start,'utcEnd':utc(),'durationSeconds':(time.monotonic_ns()-mono)/1e9,'exitCode':proc.returncode,'stdout':{'path':str(stdout.relative_to(OUT)),'bytes':stdout.stat().st_size,'sha256':sha(stdout)},'stderr':{'path':str(stderr.relative_to(OUT)),'bytes':stderr.stat().st_size,'sha256':sha(stderr)}}
runtime={'utc':utc(),'expectedNode':'v24.20.0','expectedPnpm':'10.15.0','envOverrides':{'GIT_OPTIONAL_LOCKS':'0'},'removedEnvironmentNames':removed,'commands':[]}
for name,command,expect in [('node-version',['node','--version'],'v24.20.0'),('pnpm-version',['pnpm','--version'],'10.15.0')]:
 receipt=run(name,command)
 receipt['observed']=(OUT/receipt['stdout']['path']).read_text().strip()
 receipt['matchesExpected']=receipt['exitCode']==0 and receipt['observed']==expect
 runtime['commands'].append(receipt)
runtime['ok']=all(r['matchesExpected'] for r in runtime['commands'])
write(OUT/'runtime.json',runtime)
source=run('preflight.source-check',['python3',str(OUT/'source-freeze.py'),'before-gates'])
checks=[]
for name,repo in [('root',ROOT),('emulate',ROOT/'vendor/emulate')]:
 for kind,args in [('worktree',['diff-files','--raw','-z','--ignore-submodules=none']),('index',['diff-index','--cached','--raw','-z','HEAD','--'])]:
  receipt=run(f'preflight.{name}.{kind}',['git','--no-optional-locks',*args],repo,True)
  receipt.update({'repo':name,'kind':kind,'clean':receipt['exitCode']==0 and receipt['stdout']['bytes']==0})
  checks.append(receipt)
ignored=run('preflight.ignored',['git','--no-optional-locks','check-ignore',str(OUT.relative_to(ROOT))])
baseline=json.loads((OUT/'before-gates'/'snapshot.json').read_text())
physical=[]
for name,repo in baseline['repositories'].items():
 index=pathlib.Path(repo['physicalIndexAfter']['path'])
 physical.append({'repo':name,'path':str(index),'bytes':index.stat().st_size,'sha256':sha(index),'unchanged':index.stat().st_size==repo['physicalIndexBefore']['bytes'] and sha(index)==repo['physicalIndexBefore']['sha256']})
assessment={'utc':utc(),'runtimePass':runtime['ok'],'sourceCheckExitCode':source['exitCode'],'sourceCheck':source,'initialSnapshot':'before-gates/snapshot.json','initialSnapshotSha256':sha(OUT/'before-gates'/'snapshot.json'),'auditDirectoryIgnored':ignored['exitCode']==0,'auditDirectoryIgnoreCheck':ignored,'cleanTrackedChecks':checks,'physicalIndexPreflightReadback':physical,'untrackedObservation':{'path':'critic-work/e7-t06-skeptic.test.ts','action':'left untouched; excluded from clean-tracked constraint by assignment'}}
assessment['allRequiredSourceFreezeChecksPass']=runtime['ok'] and source['exitCode']==0 and baseline['ok'] and assessment['auditDirectoryIgnored'] and all(c['clean'] for c in checks) and all(c['unchanged'] for c in physical)
write(OUT/'preflight-assessment.json',assessment)
print(json.dumps({'event':'preflight-complete','passed':assessment['allRequiredSourceFreezeChecksPass'],'node':runtime['commands'][0]['observed'],'pnpm':runtime['commands'][1]['observed'],'trackedEntries':{k:r['trackedEntries'] for k,r in baseline['repositories'].items()},'sourceFailures':baseline['failures'],'physicalIndexesUnchanged':all(c['unchanged'] for c in physical)}))
raise SystemExit(0 if assessment['allRequiredSourceFreezeChecksPass'] else 1)
