#!/usr/bin/env python3
"""Check that one altered fixture event refutes the frozen replay receipt."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('proof', type=Path)
parser.add_argument('model', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
assert not args.destination.exists(), 'do not overwrite a prior check'
args.destination.mkdir(parents=True)
for layer, name in [('http','http.json'),('browser','browser.json')]:
    report = json.loads((args.proof/layer/name).read_text())
    target = args.destination/layer
    target.mkdir()
    shutil.copy2(args.proof/layer/name, target/name)
    for dump in report['dumps']:
        source = args.proof/layer/Path(dump['path']).name
        shutil.copy2(source, target/source.name)
target = args.destination/'browser/two-profiles-live.jsonl'
original = target.read_bytes()
events = [json.loads(line) for line in original.splitlines()]
changed = False
for event in events:
    payload = event.get('payload',{})
    if isinstance(payload.get('content'),str) and payload['content']:
        payload['content'] = ('X' if payload['content'][0]!='X' else 'Y') + payload['content'][1:]
        changed = True
        break
    if isinstance(payload.get('body'),str) and payload['body']:
        payload['body'] = ('X' if payload['body'][0]!='X' else 'Y') + payload['body'][1:]
        changed = True
        break
assert changed, 'no chat content found; do not bless an irrelevant mutation'
mutated = ('\n'.join(json.dumps(event,separators=(',',':'),ensure_ascii=False) for event in events)+'\n').encode()
assert mutated != original
assert len(mutated) == len(original) and sum(a!=b for a,b in zip(original,mutated)) == 1, 'mutation must alter exactly one byte'
target.write_bytes(mutated)
command = [sys.executable,str(args.model.resolve()),str(args.destination.resolve()),'--out',str((args.destination/'unexpected-success.json').resolve())]
result = subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
(args.destination/'replay.stdout.log').write_bytes(result.stdout)
(args.destination/'replay.stderr.log').write_bytes(result.stderr)
assert result.returncode != 0 and b'AssertionError' in result.stderr, 'altered evidence did not refute replay receipt'
assert not (args.destination/'unexpected-success.json').exists()
receipt = {'kind':'expected-negative-fixture-replay-sensitivity','command':command,'mutatedPath':'browser/two-profiles-live.jsonl','originalSha256':hashlib.sha256(original).hexdigest(),'mutatedSha256':hashlib.sha256(mutated).hexdigest(),'changedByteCount':1,'mutation':'one semantic character in one synthetic chat event; JSON remains valid; recorded receipt unchanged','exitCode':result.returncode,'rejected':True,'stdoutSha256':hashlib.sha256(result.stdout).hexdigest(),'stderrSha256':hashlib.sha256(result.stderr).hexdigest(),'productionDataUsed':False}
(args.destination/'sensitivity.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
