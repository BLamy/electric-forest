from pathlib import Path
import os,json,hashlib,subprocess
out=Path(__file__).resolve().parent
pruned={'repo','official-cold-tmp','__pycache__'}; files=[];excluded=[]
for directory,dirs,names in os.walk(out):
 dirs[:]=[d for d in dirs if not (Path(directory)==out and d in pruned) and d!='__pycache__']
 for name in names:
  path=Path(directory)/name;rel=path.relative_to(out).as_posix()
  if name=='portable-artifact-index.json':continue
  if path.suffix in ['.mp4','.webm','.png'] and not rel.startswith(('cold-evidence/','video-inspection/')):
   excluded.append(rel);continue
  if name=='deployment.json' or (name=='artifact.json' and rel!='baseline-http/artifact.json'):
   excluded.append(rel);continue
  b=path.read_bytes();role='critic script/result'
  if name in ['report.json','report.md']:role='complete lead report; preserve bytes exactly'
  elif name.endswith('.log'):role='authentic raw command output'
  elif rel.startswith('sensitivity/'):role='sabotage input/result/raw receipt'
  elif rel.startswith('cold-evidence/'):role='whitelisted output from the one official cold target'
  elif rel.startswith('video-inspection/'):role='actual-origin retained-video inspection artifact'
  files.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'originalPath':str(path),'role':role})
files.sort(key=lambda f:f['path'])
report=next(f for f in files if f['path']=='report.json');readable=next(f for f in files if f['path']=='report.md');cold=json.loads((out/'cold-clone-receipt.json').read_text());coldmap=json.loads((out/'cold-evidence/mapping.json').read_text())
index={'schemaVersion':1,'sourceRoot':str(out),'artifactCount':len(files),'totalBytes':sum(f['bytes'] for f in files),'report':{'path':'report.json','bytes':report['bytes'],'sha256':report['sha256']},'readableReport':{'path':'report.md','bytes':readable['bytes'],'sha256':readable['sha256']},'files':files,'portableMappings':[{'originalPrefix':str(out)+'/', 'retainedPrefix':'./'}]+[{'original':x['original'],'retained':x['retained']} for x in coldmap['files']],'wholeCloneRelocation':{'original':cold['originalCloneDirectory'],'current':cold['retainedCloneDirectory'],'excludedFromEvidenceCopy':True},'copyPolicy':'Copy only listed paths, preserve complete report bytes, and verify size/SHA-256 after copying. Existing builder artifacts cited as ../../evidence/run-2/... already remain committed and are not duplicated here. Repository source references are bound to the full submitted/audited commit OIDs. No dependencies/build tree or whole workshop belongs in retention.','excludedTrees':['repo/**','official-cold-tmp/**','**/__pycache__/**'],'excludedUnreferencedFiles':sorted(excluded),'indexSelfExcluded':True}
(out/'portable-artifact-index.json').write_text(json.dumps(index,indent=2)+'\n')
for f in files:
 b=(out/f['path']).read_bytes();assert len(b)==f['bytes'] and hashlib.sha256(b).hexdigest()==f['sha256']
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()=='a7e861d023651925a16e9103c0f50fce9c368a4e'
assert subprocess.check_output(['git','status','--short','--untracked-files=no'],text=True)==''
assert subprocess.check_output(['git','status','--short','--untracked-files=no'],cwd=out/'repo',text=True)==''
print(json.dumps({'index':str(out/'portable-artifact-index.json'),'sha256':hashlib.sha256((out/'portable-artifact-index.json').read_bytes()).hexdigest(),'artifactCount':len(files),'totalBytes':index['totalBytes'],'report':index['report'],'readable':index['readableReport'],'rootAndScratchTrackedClean':True},indent=2))
