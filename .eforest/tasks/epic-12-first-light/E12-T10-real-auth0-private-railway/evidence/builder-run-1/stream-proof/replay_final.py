#!/usr/bin/env python3
"""Verify final fixture receipts with independent identity/chat/namespace models."""
import argparse
import hashlib
import json
from pathlib import Path
from identity import canonical, reduce_identity
from chat import replay as replay_chat
from namespace import compose_namespace, replay_namespace


def hash_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def read_records(path):
    raw = path.read_bytes()
    assert not raw or raw.endswith(b'\n'), 'truncated JSONL'
    events = [json.loads(line) for line in raw.splitlines()]
    return raw, events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('proof', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    proof = args.proof.resolve()
    browser = json.loads((proof / 'browser/browser.json').read_text())
    http = json.loads((proof / 'http/http.json').read_text())
    assert browser['sourceRevision'] == http['sourceRevision']
    assert browser['proof'] == 'dedicated-fixture browser fallback; not actual Auth0 operator'
    assert not browser['productionCredentialsUsed'] and not http['productionCredentialsUsed']
    assert not browser['consoleErrors'] and not browser['pageErrors'] and not browser['requestFailures']
    results = []
    for layer, report in [('http', http), ('browser', browser)]:
        for item in report['dumps']:
            path = proof / layer / Path(item['path']).name
            raw, records = read_records(path)
            kind = item.get('layer', 'namespace' if item.get('streamId', '').startswith('ns:') else 'branch-genesis' if item.get('streamId', '').startswith('fs:') else 'identity')
            if kind == 'identity':
                state, _ = reduce_identity(records)
                value = hash_bytes(canonical(state))
            elif kind == 'chat-channel':
                value = hash_bytes(canonical(replay_chat(records)))
            elif kind == 'namespace':
                value = hash_bytes(canonical(replay_namespace(records)))
            elif kind == 'branch-genesis':
                assert records == [{'offset':'0000000000000000_0000000000000000','type':'fs.branch.genesis','ts':1800000000000,'payload':{'v':1,'actor':'auth0|e12-t10-fixture-ada','branch':'main','writer':{'v':1,'sub':'auth0|e12-t10-fixture-ada','seq':1}}}]
                value = hash_bytes(canonical(records))
            else:
                raise ValueError(kind)
            if 'digest' in item:
                assert value == item['digest'], (path, value, item['digest'])
            application_offset = records[-1]['offset'] if records else '-1'
            if 'lastApplicationOffset' in item:
                assert item['lastApplicationOffset'] == application_offset
            if kind == 'chat-channel':
                assert item['offset'] == application_offset
            if 'sha256' in item:
                assert item['sha256'] == hash_bytes(raw)
            results.append({'path': str(path.relative_to(proof)), 'layer': kind, 'bytesSha256': hash_bytes(raw), 'records': len(records), 'lastApplicationOffset': application_offset, 'transportCursor': item.get('transportCursor'), 'independentDigest': value, 'receiptDigest': item.get('digest'), 'comparison': 'equal' if 'digest' in item else 'independently reduced; namespace relationship checked below' if kind == 'namespace' else 'exact dedicated branch-genesis record; no metadata projection digest claim'})
    persistence = []
    for folder, before, after in [('http', 'identity-before-restart', 'identity-after-restart'), ('browser', 'browser-identity-before-restart', 'browser-identity-after-restart')]:
        left = (proof / folder / (before + '.jsonl')).read_bytes()
        right = (proof / folder / (after + '.jsonl')).read_bytes()
        assert left == right
        persistence.append({'layer': 'identity', 'folder': folder, 'before': before + '.jsonl', 'after': after + '.jsonl', 'byteIdentical': True, 'sha256': hash_bytes(left)})
    for folder, before, after in [('http','chat-before','chat-final'),('browser','witness-reconnected','active-session-after-restart')]:
        left=(proof/folder/(before+'.jsonl')).read_bytes(); right=(proof/folder/(after+'.jsonl')).read_bytes()
        assert left == right
        persistence.append({'layer':'chat-channel','folder':folder,'before':before+'.jsonl','after':after+'.jsonl','byteIdentical':True,'sha256':hash_bytes(left)})
    http_ns={}
    for stream in ['ns:root','ns:org:private-ada','ns:org:private-grace']:
        _, http_ns[stream] = read_records(proof/'http'/(stream.replace(':','-')+'.jsonl'))
    http_view=compose_namespace(http_ns)
    assert sorted(http_view['orgs']) == ['private-ada','private-grace']
    for role in ['ada','grace']:
        org=http_view['orgs']['private-'+role]
        assert org['owner'] == 'auth0|e12-t10-fixture-'+role
        assert org['repos']['notebook'] == {'owner':org['owner'],'project':'notes','visibility':'private'}
    ns={}
    for stream in ['ns:root','ns:org:browser-ada','ns:org:browser-grace']:
        _, ns[stream] = read_records(proof/'browser'/(stream.replace(':','-')+'.jsonl'))
    view=compose_namespace(ns)
    assert sorted(view['orgs']) == ['browser-ada','browser-grace']
    assert view['orgs']['browser-ada']['owner'] == 'auth0|e12-t10-fixture-ada'
    assert view['orgs']['browser-grace']['owner'] == 'auth0|e12-t10-fixture-grace'
    result={'sourceRevision':browser['sourceRevision'],'method':'standalone Python models; no product imports; fixture-only dumps; no comparison between opaque transport cursors and application offsets','browserZeroErrors':True,'records':results,'persistence':persistence,'namespace':{'owners':{key:value['owner'] for key,value in view['orgs'].items()},'digest':hash_bytes(canonical(view)), 'httpNamespaceDigest':hash_bytes(canonical(http_view)), 'httpRepositoriesPrivate':True},'modelDigests':{name:hash_bytes((Path(__file__).parent/name).read_bytes()) for name in ['identity.py','chat.py','namespace.py','replay_final.py']}}
    args.out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'sourceRevision':result['sourceRevision'],'independentDumps':len(results),'persistenceComparisons':len(persistence),'namespaceDigest':result['namespace']['digest']},indent=2))


if __name__=='__main__':
    main()
