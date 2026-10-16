#!/usr/bin/env python3
"""Independent fixture namespace stream/view digests; no product imports."""
import argparse
import hashlib
import json
from pathlib import Path
from identity import canonical


def replay_namespace(records):
    state = {'kind': 'empty', 'orgs': {}, 'projects': {}, 'repos': {}}
    for index, record in enumerate(records):
        assert record['offset'] == f'{0:016d}_{index:016d}'
        kind, p = record['type'], record['payload']
        if kind == 'ns.org.create':
            assert state['kind'] != 'org' and p['name'] not in state['orgs']
            state['kind'] = 'root'
            state['orgs'][p['name']] = {'owner': p['actor']['sub']}
        else:
            assert state['kind'] != 'root'
            state['kind'] = 'org'
            if kind == 'ns.project.create':
                assert p['name'] not in state['projects']
                state['projects'][p['name']] = {'owner': p['actor']['sub']}
            elif kind == 'ns.repo.create':
                assert p['project'] in state['projects'] and p['name'] not in state['repos']
                state['repos'][p['name']] = {'owner': p['actor']['sub'], 'project': p['project'], 'visibility': p['visibility']}
            elif kind == 'ns.repo.rename':
                assert p['newName'] not in state['repos']
                state['repos'][p['newName']] = state['repos'].pop(p['name'])
            elif kind == 'ns.repo.set-visibility':
                state['repos'][p['name']]['visibility'] = p['visibility']
            else:
                raise ValueError(f'Unknown namespace event: {kind}')
    return state


def compose_namespace(streams):
    root = replay_namespace(streams['ns:root'])
    assert root['kind'] in ('empty', 'root')
    orgs = {}
    for name, info in root['orgs'].items():
        local = replay_namespace(streams.get(f'ns:org:{name}', []))
        orgs[name] = {'owner': info['owner'], 'projects': local['projects'], 'repos': local['repos']}
    return {'orgs': orgs}


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--expect-frozen', action='store_true')
    parser.add_argument('--visible-org', action='append')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    streams, result = {}, {}
    for stream, item in manifest['streams'].items():
        raw = (args.manifest.parent / item['dump']).read_bytes()
        assert not raw or raw.endswith(b'\n'), 'truncated JSONL'
        records = [json.loads(line) for line in raw.splitlines()]
        streams[stream] = records
        value = digest(replay_namespace(records))
        result[stream] = {'records': len(records), 'offset': records[-1]['offset'] if records else '-1', 'digest': value, 'bytesSha256': hashlib.sha256(raw).hexdigest()}
        if args.expect_frozen:
            assert value == item['digest'], (stream, value, item['digest'])
    view = compose_namespace(streams)
    if args.visible_org is not None:
        assert not args.expect_frozen, 'Filtered view needs its separate expected checkpoint'
        view = {'orgs': {key: value for key, value in view['orgs'].items() if key in args.visible_org}}
    view_digest = digest(view)
    if args.expect_frozen:
        assert view_digest == manifest['viewDigest'], (view_digest, manifest['viewDigest'])
    print(json.dumps({'streams': result, 'viewDigest': view_digest, 'visibleOrgs': sorted(view['orgs'])}, indent=2))


if __name__ == '__main__':
    main()
