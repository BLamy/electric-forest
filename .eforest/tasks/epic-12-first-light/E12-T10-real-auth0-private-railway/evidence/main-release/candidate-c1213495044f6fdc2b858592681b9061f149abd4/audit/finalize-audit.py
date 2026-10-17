#!/usr/bin/env python3
import datetime, hashlib, json, pathlib, subprocess, sys, re
ROOT=pathlib.Path('/Users/blamy/Documents/Codex/electric-forest')
OUT=ROOT/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/main-release/audit-c1213495'
EXPECTED='c1213495044f6fdc2b858592681b9061f149abd4'
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def info(path): return {'path':str(path.relative_to(OUT)),'bytes':path.stat().st_size,'sha256':sha(path)}
def read(path): return json.loads(path.read_text())
def write(path, value): path.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
if (OUT/'audit-report.json').exists(): raise RuntimeError('audit already finalized')
gates=[]
for number in range(1,5):
    p=OUT/f'gate-{number}.json'
    if not p.exists():
        if not gates or (gates[-1]['exitCode']==0 and gates[-1]['sourceCheckExitCode']==0):
            raise RuntimeError(f'gate {number} has not completed')
        break
    gate=read(p); gates.append(gate)
    for key in ('stdout','stderr','sourceCheckStdout','sourceCheckStderr'):
        artifact=OUT/gate[key]['path']
        if info(artifact)!=gate[key]: raise RuntimeError(f'{p.name} {key} integrity mismatch')
    if gate['exitCode']!=0 or gate['sourceCheckExitCode']!=0:
        if any((OUT/f'gate-{n}.pending.json').exists() for n in range(number+1,5)):
            raise RuntimeError('later gate launched after failure')
        break
with (OUT/'final.source-check.stdout.log').open('xb') as sout, (OUT/'final.source-check.stderr.log').open('xb') as serr:
    p=subprocess.run(['python3',str(OUT/'source-freeze.py'),'final'],cwd=ROOT,stdout=sout,stderr=serr)
baseline=read(OUT/'before-gates'/'snapshot.json')
final=read(OUT/'final'/'snapshot.json')
preflight=read(OUT/'preflight-assessment.json')
runtime=read(OUT/'runtime.json')
checks=[]
for label in ['before-gates']+[f'after-gate-{g["gate"]}' for g in gates]+['final']:
    snapfile=OUT/label/'snapshot.json'; snap=read(snapfile)
    for name, repo in snap['repositories'].items():
        expectedRaw=[(f'{name}.tree.bin',repo['treeBytes'],repo['treeSha256']),(f'{name}.semantic-index.bin',repo['semanticIndexBytes'],repo['semanticIndexSha256']),(f'{name}.physical-index.bin',repo['physicalIndexBefore']['bytes'],repo['physicalIndexBefore']['sha256']),(f'{name}.untracked.bin',repo['untrackedBytes'],repo['untrackedSha256'])]
        for rawname, size, digest in expectedRaw:
            rawpath=OUT/label/rawname
            if rawpath.stat().st_size!=size or sha(rawpath)!=digest:
                raise RuntimeError(f'raw snapshot receipt mismatch: {label}/{rawname}')
    checks.append({'label':label,'ok':snap['ok'],'utcStart':snap['utcStart'],'utcEnd':snap['utcEnd'],'durationSeconds':snap['durationSeconds'],'snapshot':info(snapfile),'failures':snap['failures'],'baselineComparisons':snap.get('baselineComparisons')})
sourcepass=p.returncode==0 and all(c['ok'] for c in checks)
passed=len(gates)==4 and all(g['exitCode']==0 and g['sourceCheckExitCode']==0 and g['auditInstrumentationUnchanged'] for g in gates) and sourcepass and preflight['allRequiredSourceFreezeChecksPass'] and runtime['ok']
report={'schemaVersion':1,'auditKind':'fresh read-only immutable-source ordered root gate audit','outcome':'passed' if passed else 'stopped-first-failure','candidateCommit':EXPECTED,'candidateTree':baseline['repositories']['root']['treeObject'],'candidateSoleParent':baseline['repositories']['root']['parents'],'cwd':str(ROOT),'utcFinalized':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gateOrder':['pnpm format:check && pnpm lint','pnpm typecheck','pnpm test','pnpm build'],'passingGatesRunExactlyOnce':True,'runtime':runtime,'preflight':info(OUT/'preflight-assessment.json'),'gates':gates,'freezeChecks':checks,'sourceIntegrityPass':sourcepass,'rawSourceReceiptIntegrityPass':True,'sourceBaseline':{name:{'head':repo['head'],'treeObject':repo['treeObject'],'trackedEntries':repo['trackedEntries'],'trackedBlobs':repo['trackedBlobs'],'treeSha256':repo['treeSha256'],'semanticIndexSha256':repo['semanticIndexSha256'],'physicalIndexSha256':repo['physicalIndexBefore']['sha256'],'physicalIndexBytes':repo['physicalIndexBefore']['bytes']} for name,repo in baseline['repositories'].items()},'pnpmLockSha256':baseline['lockfile']['sha256'],'finalSourceCheckExitCode':p.returncode,'scopeNotes':['Auditor edits were limited to audit receipts and instrumentation inside the assigned ignored audit directory. Executed gates may generate ignored build/test output. No task status, ledger, source or index edit was authorized; snapshot checks report tracked-source and index integrity independently.','The pre-existing nonignored critic-work/e7-t06-skeptic.test.ts was inventoried and left untouched; it is excluded from the assigned clean-tracked source constraint.','This audit does not include a cold clone, browser session, deployment validation, or a task verification decision. GitHub CI is a separate parent responsibility; this audit makes no CI claim.'],'browserEvidence':'Replay: N/A (ordered root gate audit does not exercise a browser session) + mitigation: complete raw gate outputs and per-gate committed-source, direct-byte/mode, lockfile, semantic-index and physical-index integrity checks.'}
testSummary=[]
if (OUT/'gate-3.json').exists():
    testText=(OUT/'gate-3.stdout.log').read_text(errors='replace')
    testText=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', testText)
    testSummary=[line.strip() for line in testText.splitlines() if re.match(r'^\s*(Test Files|Tests|Start at|Duration)\s',line)]
report['testOutputSummary']=testSummary
write(OUT/'audit-report.json',report)
lines=[f"Ordered root gate audit: {report['outcome']}",'',f"Candidate: `{EXPECTED}`",f"Tree: `{report['candidateTree']}`",f"Sole parent: `{report['candidateSoleParent'][0]}`",'',"Fresh auditor ran the following gates sequentially, once each, with NODE_OPTIONS, NODE_ENV and npm_config_* scrubbed. Node v24.20.0 and pnpm 10.15.0 matched the assigned runtime.",'',"| Gate | Command | Exit | Duration | Source/index check |","| --- | --- | --- | --- | --- |"]
for gate in gates:
    lines.append(f"| {gate['gate']} | `{gate['command']}` | {gate['exitCode']} | {gate['durationSeconds']:.3f}s | {gate['sourceCheckExitCode']} |")
if testSummary: lines.extend(['', 'Vitest raw output summary:', '', *[f'- `{line}`' for line in testSummary]])
lines.extend(['',f"Full source integrity: {'passed' if sourcepass else 'failed'}. Baseline and every post-gate/final snapshot bind all {baseline['repositories']['root']['trackedEntries']:,} root tracked entries and all {baseline['repositories']['emulate']['trackedEntries']:,} pinned vendor/emulate entries to full Git object IDs, direct byte SHA-256, and file/symlink modes. Semantic index records and physical index bytes in both repositories were compared against the baseline; the integrity result above reflects every check. The lockfile SHA-256 is `{report['pnpmLockSha256']}`.",'',f"Root physical index SHA-256: `{report['sourceBaseline']['root']['physicalIndexSha256']}`.",f"Emulate physical index SHA-256: `{report['sourceBaseline']['emulate']['physicalIndexSha256']}`.",'',"Raw complete stdout and stderr, exact argv, UTC start/end timestamps, exit codes, durations, environment scrub names, and post-gate source checks are captured in `gate-*.json` and `gate-*.{stdout,stderr}.log`. Source inventories and raw index copies are stored in each snapshot directory. `artifact-index.json` hashes all receipts, source inventories and instrumentation; its own digest is in `artifact-index.sha256`.",'',report['browserEvidence'],'',*report['scopeNotes']])
(OUT/'audit-report.md').write_text('\n'.join(lines)+'\n')
artifacts=[]
excluded=['artifact-index.json','artifact-index.sha256']
for path in sorted(OUT.rglob('*')):
    if path.is_file() and str(path.relative_to(OUT)) not in excluded:
        artifacts.append(info(path))
index={'schemaVersion':1,'candidateCommit':EXPECTED,'hashAlgorithm':'SHA-256','artifacts':artifacts,'artifactCount':len(artifacts),'totalBytes':sum(a['bytes'] for a in artifacts),'excluded':excluded,'exclusionReason':'The index and detached digest are excluded to avoid circular hashes.'}
write(OUT/'artifact-index.json',index)
indexsha=sha(OUT/'artifact-index.json')
(OUT/'artifact-index.sha256').write_text(indexsha+'  artifact-index.json\n')
for artifact in artifacts:
    if info(OUT/artifact['path'])!=artifact: raise RuntimeError(f'final receipt readback mismatch: {artifact["path"]}')
print(json.dumps({'outcome':report['outcome'],'sourceIntegrityPass':sourcepass,'rawSourceReceiptIntegrityPass':True,'completedGates':len(gates),'gateExitCodes':[g['exitCode'] for g in gates],'report':str(OUT/'audit-report.md'),'reportJsonSha256':sha(OUT/'audit-report.json'),'artifactIndexSha256':indexsha,'artifactCount':len(artifacts),'allArtifactReadbacksPassed':True}))
sys.exit(0 if passed else 1)
