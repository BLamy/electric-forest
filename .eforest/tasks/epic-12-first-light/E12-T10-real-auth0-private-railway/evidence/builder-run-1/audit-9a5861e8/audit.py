#!/usr/bin/env python3
"""Fresh once-only gate audit. Writes are confined to this file's task workshop."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

ROOT = Path('/Users/blamy/Documents/Codex/electric-forest')
OUT = Path(__file__).resolve().parent
SOURCE = '9a5861e82ec99ab2f275181a527aab5c2bfb0622'
PARENT = 'b19e7bce1cdcb06b2d11ba21d16de299402675f6'
BRANCH = 'codex/railway-hosting'
TASK = '.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway'
FREEZE = ROOT / TASK / 'work/builder-freeze-v4.json'
FREEZE_SHA = '42a8a214ba962ce73aa38fb4455a3915045e046e3bd740171d17c737a1e45f7c'
GATES = [
    ('format-lint', 'pnpm format:check && pnpm lint'),
    ('typecheck', 'pnpm typecheck'),
    ('test', 'pnpm test'),
    ('build', 'pnpm build'),
]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def ref(path):
    content = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(content), 'bytes': len(content)}


def git_at(repo, *args):
    return subprocess.check_output(['git', '--no-optional-locks', *args], cwd=repo)


def git(*args):
    return git_at(ROOT, *args)


def command_receipt(argv):
    started = now()
    proc = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return {'argv': argv, 'startedAt': started, 'endedAt': now(), 'exitCode': proc.returncode,
            'stdout': proc.stdout.decode('utf-8', 'replace').strip(),
            'stderr': proc.stderr.decode('utf-8', 'replace').strip()}


def committed_files(repo, revision, prefix):
    raw = git_at(repo, 'ls-tree', '-r', '-z', revision)
    raw_path = OUT / (prefix + '.tree.raw')
    raw_path.write_bytes(raw)
    entries = []
    for record in raw.split(b'\0'):
        if record:
            metadata, relative = record.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split(' ')
            if kind not in ('blob', 'commit'):
                raise RuntimeError('Unsupported tree entry kind')
            entries.append({'path': os.fsdecode(relative), 'mode': mode, 'kind': kind, 'gitBlob': oid})
    batch = subprocess.Popen(['git', '--no-optional-locks', 'cat-file', '--batch'], cwd=repo,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for entry in entries:
        if entry['kind'] == 'commit':
            content = entry['gitBlob'].encode()
        else:
            batch.stdin.write((entry['gitBlob'] + '\n').encode())
            batch.stdin.flush()
            header = batch.stdout.readline().split()
            if len(header) != 3 or header[1] != b'blob':
                raise RuntimeError('Unexpected committed blob response')
            content = batch.stdout.read(int(header[2]))
            if batch.stdout.read(1) != b'\n':
                raise RuntimeError('Invalid committed blob framing')
        entry.update({'sha256': sha(content), 'bytes': len(content)})
    batch.stdin.close()
    if batch.wait() != 0:
        raise RuntimeError('Committed blob reading failed')
    manifest_path = OUT / (prefix + '.files.json')
    write_json(manifest_path, entries)
    expected_index = [{'path': e['path'], 'mode': e['mode'], 'gitBlob': e['gitBlob'], 'stage': '0'}
                      for e in entries]
    semantic_path = OUT / (prefix + '.semantic-source-index.json')
    write_json(semantic_path, expected_index)
    children = []
    for entry in entries:
        if entry['kind'] == 'commit':
            child = committed_files(repo / entry['path'], entry['gitBlob'],
                                    prefix + '.submodule-' + sha(entry['path'].encode())[:12])
            child['pathInParent'] = entry['path']
            children.append(child)
    return {'repository': str(repo), 'revision': revision, 'files': ref(manifest_path),
            'treeRaw': ref(raw_path), 'semanticSourceIndex': ref(semantic_path), 'children': children}


def observed_files(repo, expected):
    entries = []
    mismatches = []
    for expected_entry in expected:
        relative = expected_entry['path']
        target = repo / relative
        try:
            metadata = target.lstat()
            if expected_entry['kind'] == 'commit':
                content = git_at(target, 'rev-parse', 'HEAD').strip()
                mode = '160000'
            elif stat.S_ISLNK(metadata.st_mode):
                content = os.fsencode(os.readlink(target))
                mode = '120000'
            elif stat.S_ISREG(metadata.st_mode):
                content = target.read_bytes()
                mode = '100755' if metadata.st_mode & stat.S_IXUSR else '100644'
            else:
                raise RuntimeError('Tracked path is neither a file, symlink nor gitlink')
            observed = {'path': relative, 'mode': mode, 'sha256': sha(content), 'bytes': len(content)}
        except (FileNotFoundError, RuntimeError) as exc:
            observed = {'path': relative, 'error': str(exc)}
        entries.append(observed)
        if any(observed.get(k) != expected_entry[k] for k in ('mode', 'sha256', 'bytes')):
            mismatches.append(relative)
    return entries, mismatches


def repo_snapshot(source, prefix):
    repo = Path(source['repository'])
    expected = json.loads((ROOT / source['files']['path']).read_text())
    expected_index = json.loads((ROOT / source['semanticSourceIndex']['path']).read_text())
    actual_files, mismatches = observed_files(repo, expected)
    files_path = OUT / (prefix + '.tracked-files.json')
    write_json(files_path, actual_files)
    index_raw = git_at(repo, 'ls-files', '--stage', '-z')
    index_raw_path = OUT / (prefix + '.index-entries.raw')
    index_raw_path.write_bytes(index_raw)
    actual_index = []
    for record in index_raw.split(b'\0'):
        if record:
            metadata, relative = record.split(b'\t', 1)
            mode, oid, stage = metadata.decode().split(' ')
            actual_index.append({'path': os.fsdecode(relative), 'mode': mode, 'gitBlob': oid, 'stage': stage})
    index_semantic_path = OUT / (prefix + '.semantic-index.json')
    write_json(index_semantic_path, actual_index)
    index_file = Path(os.fsdecode(git_at(repo, 'rev-parse', '--git-path', 'index')).strip())
    if not index_file.is_absolute():
        index_file = repo / index_file
    index_bytes = index_file.read_bytes()
    retained_index = OUT / (prefix + '.physical-index.raw')
    retained_index.write_bytes(index_bytes)
    diff_exit = subprocess.run(['git', '--no-optional-locks', 'diff', '--no-ext-diff',
                                '--ignore-submodules=none', '--quiet', source['revision'], '--'], cwd=repo).returncode
    children = [repo_snapshot(child, prefix + '.submodule-' + sha(child['pathInParent'].encode())[:12])
                for child in source['children']]
    result = {'repository': str(repo), 'head': git_at(repo, 'rev-parse', 'HEAD').decode().strip(),
              'tree': git_at(repo, 'rev-parse', 'HEAD^{tree}').decode().strip(),
              'trackedFiles': len(actual_files), 'trackedManifest': ref(files_path),
              'trackedVsSourceMismatches': mismatches, 'indexEntries': ref(index_raw_path),
              'semanticIndex': ref(index_semantic_path), 'indexEntriesMatchSource': actual_index == expected_index,
              'physicalIndex': {'originalPath': str(index_file), 'sha256': sha(index_bytes),
                                'bytes': len(index_bytes), 'retainedCopy': ref(retained_index)},
              'trackedDiffExitCode': diff_exit, 'submodules': children}
    result['integrityPassed'] = (result['head'] == source['revision'] and not mismatches
                                 and result['indexEntriesMatchSource'] and diff_exit == 0
                                 and all(child['integrityPassed'] for child in children))
    return result


def snapshot(label):
    started = now()
    source = json.loads((OUT / 'source-catalog.json').read_text())
    result = repo_snapshot(source, label)
    result.update({'startedAt': started, 'endedAt': now(),
                   'branch': git('branch', '--show-current').decode().strip()})
    result['integrityPassed'] = result['integrityPassed'] and result['branch'] == BRANCH
    write_json(OUT / (label + '.snapshot.json'), result)
    return result


def identity(snapshot_value):
    return {'repository': snapshot_value['repository'], 'head': snapshot_value['head'],
            'tree': snapshot_value['tree'], 'trackedFiles': snapshot_value['trackedFiles'],
            'trackedSha256': snapshot_value['trackedManifest']['sha256'],
            'indexEntriesSha256': snapshot_value['indexEntries']['sha256'],
            'semanticIndexSha256': snapshot_value['semanticIndex']['sha256'],
            'physicalIndexSha256': snapshot_value['physicalIndex']['sha256'],
            'submodules': [identity(child) for child in snapshot_value['submodules']]}


def initialize():
    if (OUT / 'state.json').exists():
        raise RuntimeError('Once-only audit already initialized')
    if git('rev-parse', 'HEAD').decode().strip() != SOURCE or git('rev-parse', 'HEAD^').decode().strip() != PARENT:
        raise RuntimeError('Frozen HEAD or direct parent mismatch')
    freeze_bytes = FREEZE.read_bytes()
    if sha(freeze_bytes) != FREEZE_SHA or len(freeze_bytes) != 17056:
        raise RuntimeError('Freeze identity mismatch')
    freeze = json.loads(freeze_bytes)
    checks = []
    def blob_check(revision, path, expected):
        proc = subprocess.run(['git', '--no-optional-locks', 'show', revision + ':' + path],
                              cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if expected['exists']:
            matched = proc.returncode == 0 and sha(proc.stdout) == expected['sha256'] and len(proc.stdout) == expected['bytes']
        else:
            matched = proc.returncode != 0
        return {'revision': revision, 'exists': proc.returncode == 0,
                'sha256': sha(proc.stdout) if proc.returncode == 0 else None,
                'bytes': len(proc.stdout) if proc.returncode == 0 else 0, 'matches': matched}
    def worktree_check(path, expected):
        target = ROOT / path
        exists = target.exists() or target.is_symlink()
        content = target.read_bytes() if exists else None
        matched = exists == expected['exists'] and (not exists or (sha(content) == expected['sha256'] and len(content) == expected['bytes']))
        return {'exists': exists, 'sha256': sha(content) if exists else None,
                'bytes': len(content) if exists else 0, 'matches': matched}
    for collection, baseline in (('changedFilesFromParent', PARENT),
                                 ('cumulativeImplementationFiles', freeze['activation'])):
        for entry in freeze[collection]:
            before = blob_check(baseline, entry['path'], entry['before'])
            after = blob_check(SOURCE, entry['path'], entry['after'])
            warm = worktree_check(entry['path'], entry['after'])
            checks.append({'collection': collection, **entry, 'beforeCheck': before,
                           'afterCheck': after, 'worktreeCheck': warm,
                           'passed': before['matches'] and after['matches'] and warm['matches']})
    for entry in freeze['previousFreezesPreservedByteForByte']:
        warm = worktree_check(entry['path'], entry)
        checks.append({'collection': 'previousFreezesPreservedByteForByte', **entry,
                       'worktreeCheck': warm, 'passed': warm['matches']})
    preservation_ref = freeze['sourcePreservation']['receipt']
    if ref(ROOT / preservation_ref['path']) != {k: preservation_ref[k] for k in ('path', 'sha256', 'bytes')}:
        raise RuntimeError('Source preservation receipt identity mismatch')
    preservation = json.loads((ROOT / preservation_ref['path']).read_text())
    for entry in preservation['preservedSourceFiles']:
        expected = {'exists': True, 'sha256': entry['sha256'], 'bytes': entry['bytes']}
        before = blob_check(PARENT, entry['path'], expected)
        after = blob_check(SOURCE, entry['path'], expected)
        warm = worktree_check(entry['path'], expected)
        checks.append({'collection': 'sourcePreservedByteForByte', **entry,
                       'beforeCheck': before, 'afterCheck': after, 'worktreeCheck': warm,
                       'passed': before['matches'] and after['matches'] and warm['matches']})
    direct = [os.fsdecode(p) for p in git('diff', '--no-renames', '--name-only', '-z', PARENT, SOURCE).split(b'\0') if p]
    cumulative = [os.fsdecode(p) for p in git('diff', '--no-renames', '--name-only', '-z', freeze['activation'], SOURCE).split(b'\0') if p]
    expected_direct = [e['path'] for e in freeze['changedFilesFromParent']]
    expected_cumulative = [e['path'] for e in freeze['cumulativeImplementationFiles']]
    reader_refs = []
    reader_bytes = []
    for suffix in ('a', 'b'):
        path = ROOT / TASK / ('work/ledger/source-v4-' + suffix + '.json')
        content = path.read_bytes()
        if len(content) != 1260 or sha(content) != '3ac5b2e15abdb105d982e5ddd9b8cd7136b9c9d07f1de8ec3f6a7855434af1f1':
            raise RuntimeError('Required fresh reader receipt mismatch')
        reader_refs.append(ref(path))
        reader_bytes.append(content)
    if reader_bytes[0] != reader_bytes[1]:
        raise RuntimeError('Fresh reader receipts differ')
    reader = json.loads(reader_bytes[0])
    if not (reader['sourceCommit'] == SOURCE and reader['attesterSourceCommit'] == PARENT
            and reader['transitionBaseIsDirectParent'] and reader['status'] == 'in-progress'
            and reader['projectStatus'] == 'building' and reader['runCount'] == 0 and reader['runCeiling'] == 10):
        raise RuntimeError('Fresh reader lifecycle preconditions failed')
    if git('rev-parse', 'origin/' + BRANCH).decode().strip() != SOURCE:
        raise RuntimeError('Candidate not observed in pushed tracking ref')
    freeze_check = {'freeze': ref(FREEZE), 'checks': checks,
                    'actualDirectPathsNoRenames': direct, 'actualCumulativePathsNoRenames': cumulative,
                    'directPathsMatch': direct == expected_direct,
                    'cumulativePathsMatch': cumulative == expected_cumulative,
                    'directFiles': len(expected_direct), 'cumulativeFiles': len(expected_cumulative),
                    'freshReaderReceipts': reader_refs, 'sourcePreservationReceipt': ref(ROOT / preservation_ref['path']),
                    'renamePolicy': 'Full before/after path manifests use --no-renames; Git default reader path list may collapse preview TOML D/A into one rename.'}
    write_json(OUT / 'freeze-check.json', freeze_check)
    if direct != expected_direct or cumulative != expected_cumulative or len(expected_direct) != 4 or len(expected_cumulative) != 29:
        raise RuntimeError('Frozen changed-path set mismatch')
    if len(preservation['preservedSourceFiles']) != 27 or not all(c['passed'] for c in checks):
        raise RuntimeError('Frozen file bytes or preserved source mismatch')
    source = committed_files(ROOT, SOURCE, 'committed-root')
    write_json(OUT / 'source-catalog.json', source)
    initial = snapshot('initial')
    versions = {name: command_receipt([name, '--version']) for name in ('node', 'pnpm', 'python3', 'git')}
    if not initial['integrityPassed'] or any(v['exitCode'] for v in versions.values()):
        raise RuntimeError('Initial source integrity or runtime inspection failed')
    if versions['node']['stdout'] != 'v24.20.0' or versions['pnpm']['stdout'] != '10.15.0' or ref(ROOT / 'pnpm-lock.yaml')['sha256'] != 'ffd8b299ca115cfd2d0be9c8ba2833c2de791a071e77e90616c364b7afd9c54a':
        raise RuntimeError('Runtime or lockfile differs from frozen expectations')
    state = {'task': 'E12-T10', 'role': 'fresh-read-only-immutable-candidate-gate-auditor',
             'sourceRevision': SOURCE, 'parentRevision': PARENT, 'branch': BRANCH,
             'startedAt': initial['startedAt'], 'repository': str(ROOT), 'versions': versions,
             'lockfile': ref(ROOT / 'pnpm-lock.yaml'), 'freezeCheck': ref(OUT / 'freeze-check.json'),
             'initialSnapshot': ref(OUT / 'initial.snapshot.json'), 'sourceCatalog': ref(OUT / 'source-catalog.json'),
             'gatePolicy': 'Exact root commands once sequentially; stop at first failure; no inherited gate credit.',
             'environmentPolicy': 'Inherited environment unchanged; no credentials or environment values captured.',
             'exclusions': 'No implementation/index/lifecycle edits, Docker, Make task verifier, cold clone or browser run.',
             'status': 'running', 'gates': []}
    write_json(OUT / 'state.json', state)
    print(json.dumps({'event': 'initialized', 'head': SOURCE, 'trackedFiles': initial['trackedFiles'],
                      'node': versions['node']['stdout'], 'pnpm': versions['pnpm']['stdout'],
                      'freezeDirectFiles': len(expected_direct), 'freezeCumulativeFiles': 29}), flush=True)


def run_gate(number):
    state = json.loads((OUT / 'state.json').read_text())
    if state['status'] != 'running' or len(state['gates']) != number - 1:
        raise RuntimeError('Gate once-only/order guard refused invocation')
    if number > 1 and state['gates'][-1]['status'] != 'passed':
        raise RuntimeError('Prior gate did not pass')
    name, command = GATES[number - 1]
    prefix = 'gate-%02d-%s' % (number, name)
    before = snapshot(prefix + '-before')
    initial = json.loads((OUT / 'initial.snapshot.json').read_text())
    if not before['integrityPassed'] or identity(before) != identity(initial):
        state.update({'status': 'source-integrity-failed', 'failureBeforeGate': number})
        write_json(OUT / 'state.json', state)
        raise RuntimeError('Source changed before gate; gate not invoked')
    record = {'number': number, 'name': name, 'command': command, 'argv': ['/bin/zsh', '-c', command],
              'cwd': str(ROOT), 'invocationCount': 1, 'startedAt': now(), 'status': 'running',
              'beforeSnapshot': ref(OUT / (prefix + '-before.snapshot.json'))}
    state['gates'].append(record)
    write_json(OUT / 'state.json', state)
    handles = {kind: (OUT / (prefix + '.' + kind + '.log')).open('xb')
               for kind in ('stdout', 'stderr', 'raw')}
    events_path = OUT / (prefix + '.output-events.jsonl')
    started_mono = time.monotonic()
    with events_path.open('x') as events:
        process = subprocess.Popen(record['argv'], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        record['pid'] = process.pid
        write_json(OUT / 'state.json', state)
        print(json.dumps({'event': 'gate-start', 'gate': number, 'command': command,
                          'pid': process.pid, 'startedAt': record['startedAt']}), flush=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        offsets = {'stdout': 0, 'stderr': 0, 'raw': 0}
        sequence = 0
        while selector.get_map():
            for key, unused in selector.select(timeout=1):
                content = os.read(key.fileobj.fileno(), 65536)
                if not content:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                stream = key.data
                events.write(json.dumps({'sequence': sequence, 'at': now(),
                                         'secondsSinceStart': time.monotonic() - started_mono,
                                         'stream': stream, 'streamOffset': offsets[stream],
                                         'rawOffset': offsets['raw'], 'bytes': len(content),
                                         'sha256': sha(content)}) + '\n')
                events.flush()
                for destination in (stream, 'raw'):
                    handles[destination].write(content)
                    handles[destination].flush()
                    offsets[destination] += len(content)
                sequence += 1
        exit_code = process.wait()
    for handle in handles.values():
        handle.close()
    record.update({'exitCode': exit_code, 'endedAt': now(),
                   'durationSeconds': time.monotonic() - started_mono,
                   'logs': {kind: ref(OUT / (prefix + '.' + kind + '.log')) for kind in handles},
                   'outputEvents': ref(events_path), 'outputChunks': sequence})
    after = snapshot(prefix + '-after')
    unchanged = identity(before) == identity(after) == identity(initial)
    record.update({'afterSnapshot': ref(OUT / (prefix + '-after.snapshot.json')),
                   'sourceIntegrityPassed': before['integrityPassed'] and after['integrityPassed'],
                   'allTrackedAndIndexUnchanged': unchanged})
    record['status'] = 'passed' if exit_code == 0 and record['sourceIntegrityPassed'] and unchanged else 'failed'
    if record['status'] != 'passed':
        state['status'] = 'failed'
    elif number == len(GATES):
        state['status'] = 'passed'
    write_json(OUT / 'state.json', state)
    print(json.dumps({'event': 'gate-end', 'gate': number, 'status': record['status'],
                      'exitCode': exit_code, 'durationSeconds': record['durationSeconds'],
                      'allTrackedAndIndexUnchanged': unchanged}), flush=True)


def validate_capture(state):
    results = []
    for gate in state['gates']:
        if 'logs' not in gate:
            continue
        contents = {kind: (ROOT / citation['path']).read_bytes() for kind, citation in gate['logs'].items()}
        for kind, content in contents.items():
            if sha(content) != gate['logs'][kind]['sha256'] or len(content) != gate['logs'][kind]['bytes']:
                raise RuntimeError('Recorded log file digest changed')
        offsets = {'stdout': 0, 'stderr': 0, 'raw': 0}
        events_bytes = (ROOT / gate['outputEvents']['path']).read_bytes()
        if sha(events_bytes) != gate['outputEvents']['sha256']:
            raise RuntimeError('Output events digest changed')
        events = [json.loads(line) for line in events_bytes.splitlines()]
        for sequence, event in enumerate(events):
            stream = event['stream']
            size = event['bytes']
            if event['sequence'] != sequence or event['streamOffset'] != offsets[stream] or event['rawOffset'] != offsets['raw']:
                raise RuntimeError('Output event offsets are discontinuous')
            chunk = contents[stream][offsets[stream]:offsets[stream] + size]
            raw_chunk = contents['raw'][offsets['raw']:offsets['raw'] + size]
            if len(chunk) != size or chunk != raw_chunk or sha(chunk) != event['sha256']:
                raise RuntimeError('Merged raw log cannot be reconstructed from per-stream logs')
            offsets[stream] += size
            offsets['raw'] += size
        if offsets != {kind: len(content) for kind, content in contents.items()}:
            raise RuntimeError('Not all captured bytes are covered by output events')
        results.append({'gate': gate['number'], 'outputChunks': len(events), 'bytes': offsets,
                        'fullReconstructionPassed': True, 'allReferencedLogHashesPassed': True})
    value = {'validatedAt': now(), 'method': 'Read all retained logs afresh; reconstruct raw bytes from each timestamped per-stream chunk; validate offsets, coverage and SHA-256.',
             'status': 'passed', 'gates': results}
    write_json(OUT / 'capture-validation.json', value)
    return value


def finalize():
    state = json.loads((OUT / 'state.json').read_text())
    if state['status'] not in ('passed', 'failed', 'source-integrity-failed'):
        raise RuntimeError('Cannot finalize incomplete gate audit')
    final = snapshot('final')
    initial = json.loads((OUT / 'initial.snapshot.json').read_text())
    unchanged = final['integrityPassed'] and identity(final) == identity(initial)
    validation = validate_capture(state)
    if not unchanged:
        state['status'] = 'failed'
    state.update({'endedAt': now(), 'finalSnapshot': ref(OUT / 'final.snapshot.json'),
                  'allTrackedAndIndexUnchanged': unchanged,
                  'captureValidation': ref(OUT / 'capture-validation.json'),
                  'resultScope': 'Root gate audit only; no task verification verdict, deployed-image proof, browser proof, task verifier or cold-clone credit.',
                  'unexecutedGates': [{'number': i + 1, 'command': command} for i, (name, command) in enumerate(GATES)
                                      if i >= len(state['gates'])]})
    for gate in state['gates']:
        if gate['name'] == 'test' and 'logs' in gate:
            output = (ROOT / gate['logs']['stdout']['path']).read_text(errors='replace')
            output = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', output)
            gate['testSummaryLines'] = [line.strip() for line in output.splitlines()
                                        if re.match(r'^\s*(Test Files|Tests|Duration|Start at)\s', line)]
    write_json(OUT / 'report.json', state)
    lines = ['# E12-T10 immutable candidate root gate audit', '',
             'Result: **' + state['status'].upper() + '** (root gates only).', '',
             '- Source: `' + SOURCE + '`; direct parent: `' + PARENT + '`.',
             '- Branch: `' + BRANCH + '`.',
             '- Runtime: Node `' + state['versions']['node']['stdout'] + '`, pnpm `' + state['versions']['pnpm']['stdout'] + '`.',
             '- Lockfile SHA-256: `' + state['lockfile']['sha256'] + '`.',
             '- Freeze SHA-256: `' + FREEZE_SHA + '`; 4 direct and 29 cumulative before/after path entries match committed blobs and worktree, including deletions. All three prior freezes and all 27 runtime/app/tooling/Docker source files match their frozen byte hashes.',
             '- Source integrity: HEAD, branch, root tracked content, semantic index, physical index and all initialized submodule content/index snapshots match before and after every gate. Final comparison unchanged: `' + str(unchanged).lower() + '`.',
             '- Environment inherited unchanged; no environment values or credentials captured.', '',
             '| Gate | Exact command | Exit | Seconds | Result |',
             '| --- | --- | ---: | ---: | --- |']
    for gate in state['gates']:
        lines.append('| %d | `%s` | %s | %.3f | %s |' %
                     (gate['number'], gate['command'], gate.get('exitCode', 'N/A'),
                      gate.get('durationSeconds', 0), gate['status']))
        if 'testSummaryLines' in gate:
            test_summary = '; '.join(gate['testSummaryLines'])
    if any('testSummaryLines' in gate for gate in state['gates']):
        lines += ['', 'Captured test summary: ' + test_summary + '.']
    lines += ['', 'Commands ran exactly once in order and stopped on the first failure. Every command has full stdout, stderr, merged raw bytes, timestamped output-event chunks, UTC start/end times, exit code, duration and before/after snapshots in `report.json`. Raw output order is read-ready chunk order; per-stream bytes are exact.', '',
              'The capture validator read the logs afresh, reconstructed every merged raw chunk from per-stream offsets and checked complete coverage and all SHA-256 digests. Every root/submodule physical index is retained per snapshot; committed semantic source indexes and observed indexes are retained separately.', '',
              'No product, lifecycle or index write was made by the auditor. Nothing staged or committed. Gate commands may produce their normal ignored artifacts. No Docker, Make task verifier, cold clone or browser session was run. This report assigns no task status or critic verdict.', '',
              'Replay: N/A (read-only root command gate audit) + mitigation: complete logs, committed source manifests, per-gate root/submodule tracked/index snapshots and the artifact SHA-256 index.', '']
    (OUT / 'report.md').write_text('\n'.join(lines))
    artifacts = [ref(path) for path in sorted(OUT.iterdir()) if path.is_file() and path.name != 'artifact-index.json']
    cited_sources = [ref(ROOT / relative) for relative in ('AGENTS.md', TASK + '/readme.md', 'package.json',
                     'pnpm-workspace.yaml', 'pnpm-lock.yaml')]
    freeze = json.loads(FREEZE.read_text())
    extra_refs = [ref(FREEZE)] + [ref(ROOT / entry['path']) for entry in freeze['previousFreezesPreservedByteForByte']]
    extra_refs += [ref(ROOT / entry['path']) for collection in ('changedFilesFromParent', 'cumulativeImplementationFiles')
                   for entry in freeze[collection] if entry['after']['exists']]
    extra_refs += [ref(ROOT / freeze['sourcePreservation']['receipt']['path'])]
    extra_refs += [ref(ROOT / TASK / ('work/ledger/source-v4-' + suffix + '.json')) for suffix in ('a', 'b')]
    write_json(OUT / 'artifact-index.json', {'sourceRevision': SOURCE,
                                           'artifacts': artifacts, 'sourceTargets': cited_sources,
                                           'frozenTargets': extra_refs,
                                           'selfExclusion': 'artifact-index.json excludes itself to avoid a recursive digest.'})
    print(json.dumps({'event': 'finalized', 'status': state['status'],
                      'allTrackedAndIndexUnchanged': unchanged, 'captureValidation': validation['status'],
                      'report': ref(OUT / 'report.json'), 'markdown': ref(OUT / 'report.md'),
                      'artifactIndex': ref(OUT / 'artifact-index.json')}), flush=True)


if __name__ == '__main__':
    if sys.argv[1] == 'init':
        initialize()
    elif sys.argv[1] == 'gate':
        run_gate(int(sys.argv[2]))
    elif sys.argv[1] == 'finalize':
        finalize()
    else:
        raise RuntimeError('Unknown audit operation')
