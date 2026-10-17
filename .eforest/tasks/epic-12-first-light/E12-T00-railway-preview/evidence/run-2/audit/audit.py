from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/Users/blamy/Documents/Codex/electric-forest')
OUT = Path(__file__).resolve().parent
EXPECTED = '1f9e06b87109a93c75107842d4c8aa65902f8622'
MANIFEST = OUT / 'manifest.json'
GATES = (
    ('01-format-lint', 'pnpm format:check && pnpm lint'),
    ('02-typecheck', 'pnpm typecheck'),
    ('03-test', 'pnpm test'),
    ('04-build', 'pnpm build'),
)


def clock():
    now = datetime.datetime.now().astimezone()
    return {
        'utc': now.astimezone(datetime.timezone.utc).isoformat(),
        'local': now.isoformat(),
    }


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode()


def source_state():
    return {
        'time': clock(),
        'head_oid': git('rev-parse', 'HEAD').strip(),
        'tree_oid': git('rev-parse', 'HEAD^{tree}').strip(),
        'branch': git('branch', '--show-current').strip(),
        'tracked_status_porcelain_v1': git(
            'status', '--porcelain=v1', '--untracked-files=no'
        ),
    }


def matches(state):
    return state['head_oid'] == EXPECTED and state['tracked_status_porcelain_v1'] == ''


def clean_log(raw):
    value = raw.decode('utf-8', errors='replace')
    value = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', value)
    value = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', value)
    return value.replace('\r\n', '\n').replace('\r', '\n').encode()


def artifact(path):
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': sha(data)}


def write_manifest():
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


manifest = {
    'schema': 'eforest-fresh-gate-audit-v2',
    'task': 'E12-T00',
    'verification_run': 2,
    'role': 'fresh-read-only-gate-auditor',
    'candidate_oid': EXPECTED,
    'repository': str(ROOT),
    'audit_directory': str(OUT),
    'started_at': clock(),
    'command_sequence': [cmd for _, cmd in GATES],
    'execution': {
        'shell': '/bin/zsh -c',
        'environment': 'Inherited; no environment values recorded.',
        'sequential': True,
        'retries': 0,
        'timeouts': 'None imposed on gates.',
        'stop_on_first_failure': True,
        'tracked_source_required_clean_before_and_after_every_gate': True,
    },
    'normalization': 'UTF-8 replacement decoding; strip ANSI OSC/CSI; CRLF/CR to LF; raw bytes retained.',
    'audit_script': artifact(Path(__file__).resolve()),
    'gates': [],
    'status': 'running',
}
manifest['before'] = source_state()
write_manifest()
if not matches(manifest['before']):
    manifest['status'] = 'stopped-source-mismatch'
else:
    for name, command in GATES:
        before = source_state()
        if not matches(before):
            manifest['status'] = 'stopped-source-mismatch'
            manifest['source_mismatch_before_gate'] = {'gate': name, 'state': before}
            break
        raw_path = OUT / f'{name}.raw.log'
        normal_path = OUT / f'{name}.log'
        gate = {
            'name': name,
            'command': command,
            'cwd': str(ROOT),
            'before': before,
            'started_at': clock(),
            'status': 'running',
        }
        manifest['gates'].append(gate)
        write_manifest()
        print(f'START {command}', flush=True)
        start = time.monotonic()
        with raw_path.open('wb') as log:
            process = subprocess.Popen(
                ['/bin/zsh', '-c', command],
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            gate['process_id'] = process.pid
            write_manifest()
            code = process.wait()
        normal = clean_log(raw_path.read_bytes())
        normal_path.write_bytes(normal)
        gate.update({
            'ended_at': clock(),
            'duration_seconds': round(time.monotonic() - start, 3),
            'exit_code': code,
            'raw_log': artifact(raw_path),
            'normalized_log': artifact(normal_path),
            'output_tail': '\n'.join(normal.decode().splitlines()[-30:]),
            'after': source_state(),
            'status': 'passed' if code == 0 else 'failed',
        })
        if name == '03-test':
            text = normal.decode()
            summaries = re.findall(r'^\s*(?:Test Files|Tests|Start at|Duration)\s+.*$', text, re.MULTILINE)
            gate['test_summary_lines'] = [line.strip() for line in summaries]
            files = re.search(r'^\s*Test Files\s+(\d+) passed \((\d+)\)', text, re.MULTILINE)
            tests = re.search(r'^\s*Tests\s+(\d+) passed \((\d+)\)', text, re.MULTILINE)
            gate['test_totals'] = {
                'files_passed': int(files.group(1)) if files else None,
                'files_total': int(files.group(2)) if files else None,
                'tests_passed': int(tests.group(1)) if tests else None,
                'tests_total': int(tests.group(2)) if tests else None,
            }
        write_manifest()
        print(f'END {command}: exit={code}, seconds={gate["duration_seconds"]}, normalized_sha256={gate["normalized_log"]["sha256"]}', flush=True)
        if not matches(gate['after']):
            manifest['status'] = 'stopped-source-mismatch'
            break
        if code != 0:
            manifest['status'] = 'failed'
            break
    else:
        manifest['status'] = 'passed'

manifest['ended_at'] = clock()
manifest['after'] = source_state()
if not matches(manifest['after']):
    manifest['status'] = 'stopped-source-mismatch'
write_manifest()
manifest_sha = sha(MANIFEST.read_bytes())
(OUT / 'manifest.sha256').write_text(f'{manifest_sha}  manifest.json\n')
print(f'AUDIT {manifest["status"]}: manifest={MANIFEST}, sha256={manifest_sha}', flush=True)
sys.exit(0 if manifest['status'] == 'passed' else 1)
