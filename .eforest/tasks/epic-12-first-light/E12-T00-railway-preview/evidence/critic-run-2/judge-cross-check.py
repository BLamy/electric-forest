from pathlib import Path
import base64, hashlib, json, re, subprocess

root = Path('/Users/blamy/Documents/Codex/electric-forest')
task = root / '.eforest/tasks/epic-12-first-light/E12-T00-railway-preview'
lead = task / 'work/critic-run-2'
out = Path(__file__).resolve().parent
base = 'a7e861d023651925a16e9103c0f50fce9c368a4e'
candidate = '1f9e06b87109a93c75107842d4c8aa65902f8622'
baseline = '59aefbe244e57ce096ea05b94ad462d97d8831a8'
def git(*args): return subprocess.check_output(['git', *args], cwd=root)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def load(path): return json.loads(path.read_text())
assert git('rev-parse', 'HEAD').decode().strip() == base
assert not git('status','--porcelain','--untracked-files=no')
expected = {
    'report.json':'2db4ddb6f9fa95f05a36be4ed9d2f46af39111b7d2c8e006eb5ed28d52e6a2b7',
    'report.md':'36d52d7945c86328bedf833709412c0a754048b67829903514df2c395babd378',
    'portable-artifact-index.json':'515963c3534ca1bb7d5ecc8653b54c26dff5f71cec8d683b6a3709d813a2dd1b',
}
for path, digest in expected.items(): assert sha((lead/path).read_bytes()) == digest
index = load(lead/'portable-artifact-index.json')
for item in index['files']:
    assert not Path(item['path']).is_absolute() and '..' not in Path(item['path']).parts
    raw = (lead/item['path']).read_bytes()
    assert len(raw) == item['bytes'] and sha(raw) == item['sha256'], item['path']
assert len({item['path'] for item in index['files']}) == index['artifactCount'] == 136
assert sum(item['bytes'] for item in index['files']) == index['totalBytes'] == 3850158
builder = load(task/'evidence/run-2/artifacts.json')
for item in builder['files']:
    path = task/'evidence/run-2'/item['path']
    raw = git('show', f'{base}:{path.relative_to(root)}')
    assert sha(raw) == item['sha256'] and len(raw) == item['bytes'], item['path']
assert len(builder['files']) == 92
report = load(lead/'report.json'); coverage=load(lead/'coverage.json')
assert report['submissionCommit']==base and report['auditedAndActuallyDeployedSource']==candidate
assert report['findings']==[] and report['blockingFindings']==[]
assert len(report['completion']['criteria'])==len(report['criteria'])==8
assert len(report['completion']['attacks'])==len(report['attacks'])==7
assert len(report['completion']['sabotage'])==len(report['sabotage'])==3
assert report['completion']['coldClone']=='passed' and report['completion']['environment'].strip()
assert len(report['completion']['hunks'])==220
source = coverage['behaviorHunks']; passive = coverage['passiveMetadataAndArchiveHunks']
assert len(source)==35 and len(passive)==185
assert not coverage['uncoveredRequiredBehavior'] and not coverage['deadRequiredBehavior']
actual=[]; current=None
for line in git('diff','--unified=0',baseline,candidate).decode().splitlines():
    if line.startswith('diff --git '): current=line.split(' b/',1)[1]
    if line.startswith('@@'):
        actual.append((current,line.split('@@')[1].strip()))
    if line.startswith('Binary files '): actual.append((current,'binary artifact'))
covered=[(x['file'],x['range']) for x in source+passive]
assert sorted(actual)==sorted(covered), (len(actual),len(covered))
assert all(x['classification'] in ['executed','waived'] for x in source+passive)
assert all(x['reason'].strip() for x in source+passive)
assert all(x['file'].startswith('.eforest/') for x in passive)
since = git('diff','--name-only',candidate,base).decode().splitlines()
assert all(p.startswith(str(task.relative_to(root))) or p=='.eforest/tasks/QUEUE.md' for p in since)
for record in report['sabotage']:
    assert record['originalSha256']==record['restoredSha256'] and record['trackedClean']
    assert len(record['red'])==2 and len(record['restoredGreen'])==2
    assert all(r['exit']!=0 for r in record['red']) and all(r['exit']==0 for r in record['restoredGreen'])
    for receipt in record['red']+record['restoredGreen']:
        assert sha((lead/'sensitivity'/receipt['log']).read_bytes())==receipt['logSha256']
    assert sha(git('show',f'{candidate}:{record["file"]}'))==record['originalSha256']
    assert sha((lead/'repo'/record['file']).read_bytes())==record['restoredSha256']
cold=load(lead/'cold-clone-receipt.json'); raw=(lead/'cold-clone.log').read_bytes(); text=raw.decode()
assert cold['attempts']==1 and cold['exit']==0 and cold['status']=='passed'
assert sha(raw)==cold['logSha256']=='f647963c7f5e8322f4df618c22efd0f8f84c196bcb8e2c4b75b3a8a2dc991263'
assert text.count('cold_clone: cloning HEAD ')==1
assert '\nverify-E12-T00: OK\n' in text and '\nDEPENDENCY_INTEGRITY_OK\n' in text
assert 'Tests  18 passed (18)' in text and 'E12_T00_HTTP_OK' in text and 'E12_T00_BROWSER_OK' in text
assert text.index('packages/web-hooks build: Done') < text.index('apps/web build$ vite build')
assert not cold['originalTMPDIRHonored'] and cold['trackedStatusAfterRelocation']==''
retained=Path(cold['retainedCloneDirectory'])/'repo'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=retained).decode().strip()==base
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=retained)
def reduce_posts(raw):
    events=[json.loads(l) for l in raw.splitlines()]
    assert all(e['type']=='chat.message.post' for e in events)
    messages=[]
    for n,e in enumerate(events):
        assert e['offset']==f'0000000000000000_{n:016d}'
        p=e['payload']; assert not any(m['id']==p['id'] for m in messages)
        messages.append(dict(id=p['id'],actor=p['actor'],body=p['body'],ts=e['ts'],offset=e['offset'],threadOf=p.get('threadOf'),revision=1,editedAt=None,deleted=False))
    state={'messages':messages}
    return sha(json.dumps(state,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()),events
replay=load(lead/'independent-replay.json')
checks=[]
for record in replay['records']:
    raw=(task/'evidence/run-2'/record['path']).read_bytes()
    assert sha(raw)==record['sha256']
    if record['path'].endswith('/file.jsonl'):
        ev=[json.loads(l) for l in raw.splitlines()]
        data=base64.b64decode(next(e['payload']['contentBase64'] for e in ev if e['type']=='fs.file.write'))
        assert data==git('show',f'{candidate}:packages/platform/fixtures/preview/README.md')
        assert sha(data)==record['independentBytesDigest']=='b8092b3115e9e787dc5b1d5b984ad16d2d638611e90402ecd4fdf0000650d5e5'
    else:
        digest,events=reduce_posts(raw)
        assert record['cliDigests']==[digest,digest] and record['independentPythonDigest']==digest
        if record['path'].startswith('hosted-'):
            browser=load(task/'evidence/run-2'/Path(record['path']).parent/'browser.json')
            step=next(t for t in browser['timeline'] if t.get('dump')==Path(record['path']).name)
            assert step['digest']==digest and step['offset']==events[-1]['offset']
            assert len(step['states'])==2 and all(s['digest']==digest and s['offset']==events[-1]['offset'] for s in step['states'])
        checks.append({'path':record['path'],'digest':digest,'eventCount':len(events)})
before=(task/'evidence/run-2/hosted-before/witness-reconnected.jsonl').read_bytes()
after=(task/'evidence/run-2/hosted-after/witness-reconnected.jsonl').read_bytes()
assert after.startswith(before) and len(before.splitlines())==9 and len(after.splitlines())==11
mutated=(lead/'one-byte-mutation.jsonl').read_bytes()
assert len(mutated)==len(after) and sum(a!=b for a,b in zip(after,mutated))==1
assert reduce_posts(after)[0]=='6780c44343b29371bb7a82a012461772a665a49f977daa0fe14ba29fcdef3670'
assert reduce_posts(mutated)[0]=='09f46aad5e3bddfb7efe6a0748da07068a7625e5c975de2430d1a7cf9abc35a3'
assert report['oneByteSensitivity']['actualExitSequence']==[0,1,0]
result={'baseCommit':base,'candidate':candidate,'leadReportHashes':expected,'leadArtifacts':136,'leadBytes':3850158,'builderCommittedArtifacts':92,'coverage':{'allGitHunksExactlyEnumerated':True,'sourceConfig':35,'passiveHistoryBinary':185},'sabotages':{'intendedRedAndRestoredGreen':3,'originalBuilderAndIndependentSensorBothRed':True,'allRestoredSourceMatchesCandidate':True},'coldClone':{'attempts':1,'rawTranscriptSha256':cold['logSha256'],'passedTargetAndIntegrity':True,'webHooksBeforeVite':True,'systemTmpLimitationRetained':True,'keptCloneTrackedClean':True},'judgeIndependentPostReduction':checks,'prefix':{'beforeEvents':9,'afterEvents':11,'exactBytePrefix':True},'oneByteChangedAndDigestDifferent':True,'noExtraRootGateColdCloneOrHostedBrowserRun':True}
(out/'cross-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
