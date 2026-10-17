#!/usr/bin/env python3
"""Retain exact completed main-release receipts; never copy a fixture private store."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True)
parser.add_argument('--ci-run', required=True, type=int)
args = parser.parse_args()
assert re.fullmatch('[a-f0-9]{40}',args.source)
root = Path.cwd().resolve()
task = root/'.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway'
work = task/'work/main-release'
proof = work/('final-'+args.source[:8])
audit = work/('audit-'+args.source[:8])
destination = task/'evidence/main-release'/('candidate-'+args.source)
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==args.source
assert not destination.exists(), 'never replace an earlier evidence location'

def read(path):
    return json.loads(path.read_text())

report = read(audit/'audit-report.json')
assert report['candidateCommit']==args.source
assert report['outcome']=='passed' and report['sourceIntegrityPass']
assert report['passingGatesRunExactlyOnce'] and len(report['gates'])==4
assert all(g['exitCode']==0 and g['sourceCheckExitCode']==0 for g in report['gates'])
http = read(proof/'http/http.json')
browser = read(proof/'browser/browser.json')
independent = read(proof/'independent-replay.json')
assert http['sourceRevision']==browser['sourceRevision']==independent['sourceRevision']==args.source
assert not http['productionCredentialsUsed'] and not browser['productionCredentialsUsed']
assert not browser['consoleErrors'] and not browser['pageErrors'] and not browser['requestFailures']
assert independent['browserZeroErrors']
sensitivity = read(proof/'sensitivity-v2/sensitivity.json')
assert sensitivity['rejected'] and sensitivity['changedByteCount']==1
ci = read(work/f'ci-{args.ci_run}-source.json')
assert ci['candidateHead']==args.source and ci['treeIdentical']
assert ci['actualCheckoutCommitConfirmedInCompleteJobLog'] and ci['result']=='success'
files = {}

def select(source, target):
    source = source.resolve()
    source.relative_to(task/'work')
    assert source.is_file() and not source.is_symlink()
    assert source.name not in {'session.key','.env'} and source.suffix!='.pem'
    assert not target.is_absolute() and '..' not in target.parts
    previous = files.setdefault(target,source)
    assert previous==source

for source in sorted(audit.rglob('*')):
    if source.is_file() and '__pycache__' not in source.parts:
        select(source,Path('audit')/source.relative_to(audit))
for source in sorted(proof.glob('*')):
    if source.is_file():
        select(source,Path('proof')/source.name)
select(proof/'deadlines/deadlines.json',Path('proof/deadlines/deadlines.json'))
for layer, value, name in [('http',http,'http.json'),('browser',browser,'browser.json')]:
    select(proof/layer/name,Path('proof')/layer/name)
    for key in ['dumps','screenshots','videos']:
        for item in value.get(key,[]):
            source = Path(item['path']).resolve()
            source.relative_to(proof/layer)
            select(source,Path('proof')/layer/source.name)
for group in ['sensitivity','sensitivity-v2']:
    for source in sorted((proof/group).rglob('*')):
        if source.is_file():
            select(source,Path('proof')/group/source.relative_to(proof/group))
for group in ['ci-fix','vitest-fix']:
    for source in sorted((work/group).rglob('*')):
        if source.is_file() and source.suffix in {'.json','.jsonl','.log','.py','.mjs','.txt','.bin'} and '__pycache__' not in source.parts:
            select(source,Path(group)/source.relative_to(work/group))
for name in ['run_proof.py','check_replay_sensitivity.py','prepare_evidence.py','candidate-freeze.json','current-candidate-freeze.json','source-changesets.json','merge-resolution-matrix.json','imported-log-checks.json']:
    select(work/name,Path('provenance')/name)
for name in ['main-release-candidate-a.json','main-release-candidate-b.json','main-ci-candidate-a.json','main-ci-candidate-b.json','main-vitest-candidate-a.json','main-vitest-candidate-b.json']:
    select(task/'work/ledger'/name,Path('readers')/name)
for run in [38982064770,38982575450,args.ci_run]:
    select(work/f'ci-{run}.log',Path('github')/f'ci-{run}.log')
    receipt = work/f'ci-{run}-source.json'
    if receipt.exists():
        select(receipt,Path('github')/receipt.name)

entries = []
for target,source in sorted(files.items()):
    raw = source.read_bytes()
    assert not any(b'-----BEGIN '+kind+b'PRIVATE KEY-----' in raw for kind in [b'',b'RSA ',b'EC ',b'OPENSSH '])
    output = destination/target
    output.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source,output)
    assert output.read_bytes()==raw
    blob = subprocess.check_output(['git','hash-object','--no-filters','--stdin'],input=raw).decode().strip()
    entries.append({'original':str(source.relative_to(root)),'retained':str(output.relative_to(root)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'gitBlobOid':blob})
models = []
for name in ['identity.py','chat.py','namespace.py','replay_final.py']:
    path = task/'evidence/builder-run-1/stream-proof'/name
    models.append({'path':str(path.relative_to(root)),'sourceCommit':args.source,'gitBlobOid':subprocess.check_output(['git','rev-parse',args.source+':'+str(path.relative_to(root))],text=True).strip(),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
manifest = {'kind':'main-release-candidate-evidence-retention','recordedAt':datetime.now(timezone.utc).isoformat(),'sourceRevision':args.source,'sourceTree':subprocess.check_output(['git','rev-parse',args.source+'^{tree}'],text=True).strip(),'sourceLocation':'full Git commit and blob addresses; no textual patches','task':'E12-T10','taskStatus':'in-progress','verificationRunCount':0,'ciRunId':args.ci_run,'browserProof':'dedicated fixtures; Replay QA unavailable; no actual production credentials','operatorLiveEvidence':'historical9a only at this candidate checkpoint; future main rollout receipt separate','independentModelSources':models,'entries':entries,'copiedFiles':len(entries),'copiedBytes':sum(x['bytes'] for x in entries),'fixturePrivateStoresOrKeysCopied':False,'taskVerdictIssued':False}
(destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'destination':str(destination.relative_to(root)),'files':len(entries),'bytes':manifest['copiedBytes'],'manifestSha256':hashlib.sha256((destination/'manifest.json').read_bytes()).hexdigest()},indent=2))
