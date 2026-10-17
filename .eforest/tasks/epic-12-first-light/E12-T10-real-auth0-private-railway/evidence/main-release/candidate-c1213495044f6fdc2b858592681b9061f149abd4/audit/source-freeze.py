#!/usr/bin/env python3
import os, sys, json, hashlib, pathlib, subprocess, stat, datetime, time, shutil
ROOT=pathlib.Path('/Users/blamy/Documents/Codex/electric-forest')
OUT=ROOT/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/main-release/audit-c1213495'
CANDIDATE='c1213495044f6fdc2b858592681b9061f149abd4'
PARENT='1eda083c1ab66bb89125734610063e14cdd448e8'
MANIFEST=OUT/'candidate-files.json'
EXPECTED_MANIFEST='f69f546d2825e62c89bb4f41d5daf2b6fc0fa0cc4e337e5888ff46d2fba720d2'
ENV={**os.environ, 'GIT_OPTIONAL_LOCKS':'0'}
def sha(b): return hashlib.sha256(b).hexdigest()
def git(cwd,*args):
 p=subprocess.run(['git','--no-optional-locks',*args],cwd=cwd,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode: raise RuntimeError(f'git {args}: {p.returncode}: {p.stderr.decode(errors="replace")}')
 return p.stdout

def gitdir(repo):
 p=repo/'.git'
 if p.is_dir(): return p.resolve()
 data=p.read_text().strip()
 if not data.startswith('gitdir: '): raise RuntimeError(f'unsupported gitdir {p}')
 return (repo/data[8:]).resolve()

def record_file(p):
 b=p.read_bytes(); s=p.stat()
 return {'path':str(p),'bytes':len(b),'sha256':sha(b),'mode':oct(stat.S_IMODE(s.st_mode)), 'mtimeNs':s.st_mtime_ns, 'inode':s.st_ino}

def parse_tree(data):
 out=[]
 for ent in data.split(b'\0'):
  if not ent: continue
  before,path=ent.split(b'\t',1)
  mode,typ,oid=before.decode().split(' ')
  out.append({'path':path.decode(), 'mode':mode,'type':typ,'gitObject':oid})
 return out

def parse_index(data):
 out=[]
 for ent in data.split(b'\0'):
  if not ent: continue
  before,path=ent.split(b'\t',1)
  mode,oid,stage=before.decode().split(' ')
  out.append({'path':path.decode(),'mode':mode,'gitObject':oid,'stage':int(stage)})
 return out

def committed_blobs(repo, entries):
 blobs=[e for e in entries if e['type']=='blob']
 inp=('\n'.join(e['gitObject'] for e in blobs)+'\n').encode()
 p=subprocess.run(['git','--no-optional-locks','cat-file','--batch'],cwd=repo,env=ENV,input=inp,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode: raise RuntimeError(p.stderr.decode())
 data=p.stdout; pos=0; records={}
 for e in blobs:
  n=data.index(b'\n',pos); header=data[pos:n].decode(); pos=n+1
  oid,typ,count=header.split(' '); size=int(count)
  b=data[pos:pos+size]; pos+=size
  if data[pos:pos+1]!=b'\n': raise RuntimeError('malformed cat-file termination')
  pos+=1
  got=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
  if typ!='blob' or oid!=e['gitObject'] or got!=oid: raise RuntimeError(f'corrupt Git object {e["path"]}')
  records[e['path']]={'bytes':len(b),'sha256':sha(b)}
 if pos!=len(data): raise RuntimeError('unparsed cat-file output')
 return records

def worktree(repo,entries,objects):
 rows=[]; failures=[]
 for e in entries:
  r=dict(e); p=repo/e['path']
  if e['type']=='commit':
   r['worktreeKind']='gitlink'; rows.append(r); continue
  try:
   st=p.lstat()
   if stat.S_ISLNK(st.st_mode):
    b=os.readlink(p).encode(); mode='120000'; kind='symlink'
   elif stat.S_ISREG(st.st_mode):
    b=p.read_bytes(); mode='100755' if st.st_mode & 0o111 else '100644'; kind='file'
   else: raise RuntimeError(f'not regular/symlink: {p}')
   got=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
   r.update({'worktreeKind':kind,'worktreeMode':mode,'worktreePosixMode':oct(stat.S_IMODE(st.st_mode)),'worktreeGitObject':got,'worktreeBytes':len(b),'worktreeSha256':sha(b),'committedBytes':objects[e['path']]['bytes'],'committedSha256':objects[e['path']]['sha256']})
   if got!=e['gitObject'] or mode!=e['mode'] or sha(b)!=objects[e['path']]['sha256']:
    failures.append({'path':e['path'],'reason':'worktree differs from committed object/mode','expected':e,'actual':r})
  except Exception as ex:
   failures.append({'path':e['path'],'reason':str(ex)})
  rows.append(r)
 return rows,failures

def write_json(path,value): path.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')

def snapshot(label):
 start=time.monotonic_ns(); now=datetime.datetime.now(datetime.timezone.utc).isoformat()
 dest=OUT/label; dest.mkdir(exist_ok=False)
 repos=[('root',ROOT),('emulate',ROOT/'vendor/emulate')]
 physical_before={}
 for name,repo in repos:
  ip=gitdir(repo)/'index'; saved=dest/f'{name}.physical-index.bin'; shutil.copyfile(ip,saved)
  physical_before[name]=record_file(ip)
 failures=[]
 mb=MANIFEST.read_bytes(); manifest=json.loads(mb)
 if sha(mb)!=EXPECTED_MANIFEST: failures.append({'reason':'candidate manifest hash mismatch'})
 if manifest.get('candidateCommit')!=CANDIDATE: failures.append({'reason':'candidate manifest commit mismatch'})
 result={'schemaVersion':1,'label':label,'cwd':str(ROOT),'utcStart':now,'candidateCommit':CANDIDATE,'candidateManifest':record_file(MANIFEST),'gitOptionalLocks':'0','repositories':{},'failures':failures}
 for name,repo in repos:
  head=git(repo,'rev-parse','HEAD').decode().strip()
  parents=git(repo,'show','-s','--format=%P','HEAD').decode().strip().split()
  tree_oid=git(repo,'rev-parse','HEAD^{tree}').decode().strip()
  tree_raw=git(repo,'ls-tree','-r','-z','HEAD'); (dest/f'{name}.tree.bin').write_bytes(tree_raw)
  tree=parse_tree(tree_raw)
  index_raw=git(repo,'ls-files','--stage','-z'); (dest/f'{name}.semantic-index.bin').write_bytes(index_raw)
  index=parse_index(index_raw)
  expected_index=[{'path':e['path'],'mode':e['mode'],'gitObject':e['gitObject'],'stage':0} for e in tree]
  if index!=expected_index: failures.append({'repo':name,'reason':'semantic index differs from HEAD tree'})
  if name=='root':
   if head!=CANDIDATE or parents!=[PARENT] or tree_oid!=manifest['candidateTree']: failures.append({'reason':'candidate identity/parent mismatch','head':head,'parents':parents})
   if tree!=manifest['files']: failures.append({'reason':'HEAD tree differs from supplied candidate-files manifest'})
  else:
   pinned=next(e['gitObject'] for e in result['repositories']['root']['tree'] if e['path']=='vendor/emulate')
   if head!=pinned: failures.append({'repo':name,'reason':'submodule HEAD differs from root gitlink','head':head,'pinned':pinned})
  objects=committed_blobs(repo,tree)
  files,bad=worktree(repo,tree,objects); failures.extend({'repo':name,**b} for b in bad)
  untracked=git(repo,'ls-files','--others','--exclude-standard','-z'); (dest/f'{name}.untracked.bin').write_bytes(untracked)
  physical_after=record_file(gitdir(repo)/'index')
  before=physical_before[name]
  if physical_after['sha256']!=before['sha256'] or physical_after['bytes']!=before['bytes']:
   failures.append({'repo':name,'reason':'physical index changed during read-only snapshot','before':before,'after':physical_after})
  result['repositories'][name]={'cwd':str(repo),'head':head,'treeObject':tree_oid,'parents':parents,'trackedEntries':len(tree),'trackedBlobs':len(objects),'tree':tree,'files':files,'physicalIndexBefore':before,'physicalIndexAfter':physical_after,'semanticIndexBytes':len(index_raw),'semanticIndexSha256':sha(index_raw),'treeBytes':len(tree_raw),'treeSha256':sha(tree_raw),'untrackedBytes':len(untracked),'untrackedSha256':sha(untracked)}
 result['lockfile']=record_file(ROOT/'pnpm-lock.yaml')
 result['utcEnd']=datetime.datetime.now(datetime.timezone.utc).isoformat(); result['durationSeconds']=(time.monotonic_ns()-start)/1e9
 if label!='before-gates':
  baseline=json.loads((OUT/'before-gates'/'snapshot.json').read_text()); comparisons={}
  for name in ('root','emulate'):
   b=baseline['repositories'][name]; a=result['repositories'][name]
   fields=['head','treeObject','parents','treeSha256','semanticIndexSha256','files']
   comparisons[name]={k:a[k]==b[k] for k in fields}
   comparisons[name]['physicalIndexBytesUnchanged']=a['physicalIndexAfter']['bytes']==b['physicalIndexBefore']['bytes']
   comparisons[name]['physicalIndexSha256Unchanged']=a['physicalIndexAfter']['sha256']==b['physicalIndexBefore']['sha256']
   if not all(comparisons[name].values()): failures.append({'repo':name,'reason':'snapshot differs from pre-gate baseline','comparisons':comparisons[name]})
  comparisons['lockfileSha256Unchanged']=result['lockfile']['sha256']==baseline['lockfile']['sha256']
  result['baselineComparisons']=comparisons
  if not comparisons['lockfileSha256Unchanged']: failures.append({'reason':'lockfile changed'})
 result['ok']=not failures
 write_json(dest/'snapshot.json',result)
 print(json.dumps({'label':label,'ok':result['ok'],'failures':failures,'trackedEntries':{k:v['trackedEntries'] for k,v in result['repositories'].items()},'physicalIndexSha256':{k:v['physicalIndexAfter']['sha256'] for k,v in result['repositories'].items()},'lockfileSha256':result['lockfile']['sha256'],'snapshotSha256':sha((dest/'snapshot.json').read_bytes()),'durationSeconds':result['durationSeconds']}))
 return 0 if result['ok'] else 1
if __name__=='__main__': sys.exit(snapshot(sys.argv[1]))
