from pathlib import Path
import json,subprocess,hashlib,shutil,os,re
out=Path(__file__).resolve().parent;repo=out/'repo';root=Path.cwd();task=out.parent.parent;base=task/'evidence/run-2'
selected=json.loads(subprocess.check_output(['pnpm','--filter','@eforest/web...','--filter','@eforest/cli...','list','--depth','-1','--json'],cwd=repo,text=True));packages=[]
for p in selected:
 path=Path(p['path']);d=json.loads((path/'package.json').read_text());assert d.get('scripts',{}).get('build');packages.append({'name':d['name'],'path':str(path.relative_to(repo)),'build':d['scripts']['build']})
assert len(packages)==16;assert any(p['name']=='@eforest/web-hooks' for p in packages)
# Check source does not change after audited/deployed 1f9e06b8, apart from retained task evidence/claims.
paths=subprocess.check_output(['git','diff','--name-only','1f9e06b87109a93c75107842d4c8aa65902f8622','a7e861d023651925a16e9103c0f50fce9c368a4e'],text=True).splitlines();assert all(p == '.eforest/tasks/QUEUE.md' or p.startswith('.eforest/tasks/epic-12-first-light/E12-T00-railway-preview/') for p in paths)
# Runtime imports must resolve through the independently installed clone.
links=[]
for p in [repo/'packages/platform/node_modules/@eforest/server',repo/'packages/platform/node_modules/@eforest/client',repo/'apps/web/node_modules/@eforest/web-hooks']:
 assert p.is_symlink();target=p.resolve();assert target.is_relative_to(repo);links.append({'path':str(p.relative_to(repo)),'target':str(target.relative_to(repo))})
known=['synthetic','secret','canary'];needle='-'.join(known).encode();hits=[];scanned=0
for p in (repo/'apps/web/dist').rglob('*'):
 if p.is_file():
  scanned+=1
  if needle in p.read_bytes() or b'-----BEGIN PRIVATE KEY-----' in p.read_bytes():hits.append(str(p.relative_to(repo)))
assert not hits
builder_scan=json.loads((base/'retained-evidence-scan.json').read_text());assert builder_scan['findings']==[]
tools={k:shutil.which(k) for k in ['node','pnpm','ffmpeg','ffprobe','make']};chrome=os.environ.get('AGENT_BROWSER_EXECUTABLE_PATH','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');assert Path(chrome).is_file()
result={'freshInstallReceipt':'scratch-environment.json','packageClosure':packages,'packagesBuiltFromNoInitialDist':16,'workspaceLinksStayWithinClone':links,'toolPaths':tools,'browserExecutable':chrome,'credentialEnvironmentNamesPresent':[k for k,v in os.environ.items() if v and re.search(r'AUTH0_|OIDC_|RESEND_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|AWS_|GITHUB_TOKEN$|GH_TOKEN$|GOOGLE_APPLICATION_CREDENTIALS$',k)],'credentialValuesNeverRecorded':True,'dataBoundary':'Every local test runtime receives an explicit synthetic environment object and new task-work directory; no inherited auth file is read. Deployed process variable names are the nine declared fixture/public/build fields in railway/manifest.json. Real platform gateway and pinned official server/reducers are used, not network mocks.','goldenBoundary':'README is frozen committed bytes; chat digests verified via independent Python reducer and double CLI replay, plus one-byte red sensor. Runtime-generated message IDs/timestamps are input variation, never blessed expected goldens.','sourceChangesSinceAuditedCandidate':paths,'localWebFilesScannedIncludingSourceMaps':scanned,'knownCanaryFindings':hits,'archiveEvidenceCanaryScan':builder_scan,'artifactInventoryDifference':'Scratch/a7 task metadata causes different browser asset hashes; full root deployed artifact inventory equality is not claimed. Hosted 1f9 source and independently replayed byte streams are the authority.'}
(out/'environment-review.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'selectedPackages':len(packages),'workspaceLinksStayWithinClone':True,'localWebFilesScannedIncludingSourceMaps':scanned,'canaryFindings':hits,'sourceOnlyTaskMetadata':True,'toolPaths':tools},indent=2))
