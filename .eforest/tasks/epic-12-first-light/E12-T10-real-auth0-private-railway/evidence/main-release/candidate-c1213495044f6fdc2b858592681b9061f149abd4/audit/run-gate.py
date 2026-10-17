#!/usr/bin/env python3
import os, sys, pathlib, json, subprocess, time, datetime, hashlib
ROOT=pathlib.Path('/Users/blamy/Documents/Codex/electric-forest')
OUT=ROOT/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/main-release/audit-c1213495'
COMMANDS={1:'pnpm format:check && pnpm lint',2:'pnpm typecheck',3:'pnpm test',4:'pnpm build'}
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def meta(p): return {'path':str(p.relative_to(OUT)),'bytes':p.stat().st_size,'sha256':sha(p)}
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
n=int(sys.argv[1]); command=COMMANDS[n]
recordpath=OUT/f'gate-{n}.json'; pendingpath=OUT/f'gate-{n}.pending.json'
if recordpath.exists() or pendingpath.exists(): raise RuntimeError('gate already launched; no rerun permitted')
if n==1:
 if not json.loads((OUT/'preflight-assessment.json').read_text())['allRequiredSourceFreezeChecksPass']: raise RuntimeError('preflight failed')
 if not json.loads((OUT/'runtime.json').read_text())['ok']: raise RuntimeError('runtime failed')
else:
 previous=json.loads((OUT/f'gate-{n-1}.json').read_text())
 if previous['exitCode']!=0 or previous['sourceCheckExitCode']!=0: raise RuntimeError('previous gate failed')
removed=sorted(k for k in os.environ if k.upper() in ('NODE_OPTIONS','NODE_ENV') or k.lower().startswith('npm_config_'))
env={k:v for k,v in os.environ.items() if k not in removed}
env['GIT_OPTIONAL_LOCKS']='0'
start=utc(); monotonic=time.monotonic_ns()
argv=['/bin/zsh','-f','-c',command]
stdoutpath=OUT/f'gate-{n}.stdout.log'; stderrpath=OUT/f'gate-{n}.stderr.log'
record={'gate':n,'command':command,'argv':argv,'cwd':str(ROOT),'utcStart':start,'monotonicStartNs':monotonic,'envOverrides':{'GIT_OPTIONAL_LOCKS':'0'},'removedEnvironmentNames':removed,'runnerPid':os.getpid(),'sourceFreezeScript':meta(OUT/'source-freeze.py'),'runnerScript':meta(OUT/'run-gate.py')}
with stdoutpath.open('xb') as sout, stderrpath.open('xb') as serr:
 process=subprocess.Popen(argv,cwd=ROOT,env=env,stdout=sout,stderr=serr,start_new_session=True)
 record['commandPid']=process.pid
 pendingpath.write_text(json.dumps(record,indent=2,sort_keys=True)+'\n')
 print(json.dumps({'event':'gate-start','gate':n,'command':command,'utcStart':start,'pid':process.pid}),flush=True)
 code=process.wait()
end=utc(); endmono=time.monotonic_ns()
record.update({'utcEnd':end,'monotonicEndNs':endmono,'durationSeconds':(endmono-monotonic)/1e9,'exitCode':code,'stdout':meta(stdoutpath),'stderr':meta(stderrpath)})
checkargv=['python3',str(OUT/'source-freeze.py'),f'after-gate-{n}']
with (OUT/f'gate-{n}.source-check.stdout.log').open('xb') as sout, (OUT/f'gate-{n}.source-check.stderr.log').open('xb') as serr:
 check=subprocess.run(checkargv,cwd=ROOT,stdout=sout,stderr=serr)
record.update({'sourceCheckArgv':checkargv,'sourceCheckExitCode':check.returncode,'sourceCheckStdout':meta(OUT/f'gate-{n}.source-check.stdout.log'),'sourceCheckStderr':meta(OUT/f'gate-{n}.source-check.stderr.log')})
record['auditInstrumentationUnchanged']=(record['sourceFreezeScript']==meta(OUT/'source-freeze.py') and record['runnerScript']==meta(OUT/'run-gate.py'))
if not record['auditInstrumentationUnchanged']: record['sourceCheckExitCode']=record['sourceCheckExitCode'] or 1
recordpath.write_text(json.dumps(record,indent=2,sort_keys=True)+'\n')
print(json.dumps({'event':'gate-complete','gate':n,'command':command,'exitCode':code,'sourceCheckExitCode':check.returncode,'durationSeconds':record['durationSeconds'],'stdout':record['stdout'],'stderr':record['stderr']}),flush=True)
sys.exit(code or record['sourceCheckExitCode'])
