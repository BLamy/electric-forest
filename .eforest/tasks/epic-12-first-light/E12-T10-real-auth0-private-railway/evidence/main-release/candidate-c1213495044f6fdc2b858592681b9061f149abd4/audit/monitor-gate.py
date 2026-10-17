#!/usr/bin/env python3
import pathlib, json, datetime, time, subprocess, sys
ROOT=pathlib.Path('/Users/blamy/Documents/Codex/electric-forest')
OUT=ROOT/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/main-release/audit-c1213495'
n=int(sys.argv[1]); pending=json.loads((OUT/f'gate-{n}.pending.json').read_text())
record={'gate':n,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(pending['utcStart'])).total_seconds(),'commandPid':pending['commandPid'],'completed':(OUT/f'gate-{n}.json').exists(),'processQueries':[]}
pids=[pending['commandPid']]
for pid in pids:
 proc=subprocess.run(['pgrep','-P',str(pid)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 record['processQueries'].append({'argv':['pgrep','-P',str(pid)],'exitCode':proc.returncode,'stdout':proc.stdout.decode(errors='replace'),'stderr':proc.stderr.decode(errors='replace')})
 for raw in proc.stdout.split():
  child=int(raw)
  if child not in pids: pids.append(child)
psargv=['ps','-p',','.join(str(p) for p in pids),'-o','pid,ppid,etime,time,pcpu,stat,comm']
proc=subprocess.run(psargv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
record['processState']={'argv':psargv,'exitCode':proc.returncode,'stdout':proc.stdout.decode(errors='replace'),'stderr':proc.stderr.decode(errors='replace')}
for stream in ['stdout','stderr']:
 path=OUT/f'gate-{n}.{stream}.log'; content=path.read_bytes()
 record[stream]={'path':path.name,'bytes':len(content),'lastLines':content.decode(errors='replace').splitlines()[-8:]}
with (OUT/f'gate-{n}.process-checkpoints.jsonl').open('a') as stream: stream.write(json.dumps(record,sort_keys=True)+'\n')
print(json.dumps({key:record[key] for key in ['gate','utc','elapsedSeconds','completed','processState','stdout','stderr']}))
