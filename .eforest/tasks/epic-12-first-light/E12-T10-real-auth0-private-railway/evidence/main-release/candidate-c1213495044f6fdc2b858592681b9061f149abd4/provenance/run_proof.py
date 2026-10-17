#!/usr/bin/env python3
"""Capture complete fixture proof output against one frozen, explicitly named commit."""
import argparse
import hashlib
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command and args.name.isidentifier()
    root = Path.cwd().resolve()
    out = args.out.resolve()
    out.relative_to(root / '.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work')
    out.mkdir(parents=True, exist_ok=True)

    def capture(*cmd):
        return subprocess.check_output(cmd, cwd=root)

    def state():
        subprocess.run(['git', 'diff-files', '--quiet'], cwd=root, check=True)
        subprocess.run(['git', 'diff-index', '--cached', '--quiet', 'HEAD'], cwd=root, check=True)
        return {
            'head': capture('git', 'rev-parse', 'HEAD').decode().strip(),
            'tree': capture('git', 'rev-parse', 'HEAD^{tree}').decode().strip(),
            'semanticIndexSha256': hashlib.sha256(capture('git', 'ls-files', '--stage', '-z')).hexdigest(),
        }

    before = state()
    assert before['head'] == args.source
    receipt_path = out / (args.name + '-command.json')
    stdout = out / (args.name + '.stdout.log')
    stderr = out / (args.name + '.stderr.log')
    assert not any(path.exists() for path in [receipt_path, stdout, stderr]), 'refusing to replace prior run'
    environment = {k:v for k,v in os.environ.items() if k not in {'NODE_OPTIONS','NODE_ENV'} and not k.lower().startswith('npm_config_')}
    started = datetime.now(timezone.utc).isoformat()
    tick = time.monotonic()
    with stdout.open('xb') as output, stderr.open('xb') as error:
        result = subprocess.run(command, cwd=root, env=environment, stdout=output, stderr=error)
    after = state()

    def file_receipt(path):
        raw = path.read_bytes()
        return {'path':str(path.relative_to(root)), 'bytes':len(raw), 'sha256':hashlib.sha256(raw).hexdigest()}

    receipt = {
        'name':args.name, 'sourceRevision':args.source, 'command':command, 'cwd':str(root),
        'startedAt':started, 'endedAt':datetime.now(timezone.utc).isoformat(),
        'elapsedSeconds':round(time.monotonic()-tick,6), 'exitCode':result.returncode,
        'before':before, 'after':after, 'candidateUnchanged':before==after,
        'environmentScrubbed':['NODE_OPTIONS','NODE_ENV','npm_config_*'],
        'stdout':file_receipt(stdout), 'stderr':file_receipt(stderr),
    }
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))
    assert before == after, 'candidate changed during proof'
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
