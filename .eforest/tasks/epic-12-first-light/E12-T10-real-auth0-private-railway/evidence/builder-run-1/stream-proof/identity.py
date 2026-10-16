#!/usr/bin/env python3
"""Independent fixture-only identity reduction; imports no Electric Forest code."""
import argparse
import hashlib
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def reduce_identity(records):
    state = {key: {} for key in ('users', 'orgs', 'memberships', 'grants', 'sessions')}
    types = {}
    for index, record in enumerate(records):
        assert record['offset'] == f'{0:016d}_{index:016d}', ('offset', index, record['offset'])
        kind, p = record['type'], record['payload']
        types[kind] = types.get(kind, 0) + 1
        if kind == 'identity.user.created':
            assert p['sub'] not in state['users']
            state['users'][p['sub']] = {'email': p['email']}
        elif kind == 'identity.org.created':
            assert p['orgId'] not in state['orgs'] and p['ownerSub'] in state['users']
            state['orgs'][p['orgId']] = {key: p[key] for key in ('name', 'ownerSub')}
            state['memberships'][p['orgId']] = {p['ownerSub']: {'role': 'owner', 'status': 'active'}}
        elif kind == 'identity.membership.granted':
            assert p['orgId'] in state['orgs'] and p['sub'] in state['users']
            members = state['memberships'][p['orgId']]
            assert members.get(p['sub'], {}).get('status') != 'active'
            members[p['sub']] = {'role': p['role'], 'status': 'active'}
        elif kind == 'identity.membership.revoked':
            assert state['orgs'][p['orgId']]['ownerSub'] != p['sub']
            member = state['memberships'][p['orgId']][p['sub']]
            assert member['status'] == 'active'
            member['status'] = 'revoked'
        elif kind == 'identity.grant.issued':
            assert p['sub'] in state['users'] and p['grantId'] not in state['grants']
            assert not any(g['status'] == 'active' and g['tokenHash'] == p['tokenHash'] for g in state['grants'].values())
            grant = {key: p[key] for key in ('sub', 'kind', 'scopes', 'tokenHash')}
            grant['status'] = 'active'
            grant.update({key: p[key] for key in ('tokenKind', 'name', 'issuedAt') if key in p})
            state['grants'][p['grantId']] = grant
        elif kind == 'identity.grant.revoked':
            grant = state['grants'][p['grantId']]
            assert grant['status'] == 'active'
            assert not any(o['grantId'] == p['grantId'] and o['status'] == 'active' for o in state.get('grantOperations', {}).values())
            grant['status'] = 'revoked'
            if 'revokedAt' in p:
                grant['revokedAt'] = p['revokedAt']
        elif kind == 'identity.grant.operation.started':
            assert state['grants'][p['grantId']]['status'] == 'active'
            operations = state.setdefault('grantOperations', {})
            assert p['operationId'] not in operations
            operations[p['operationId']] = {key: p[key] for key in ('grantId', 'startedAt', 'streamId', 'event')}
            operations[p['operationId']]['status'] = 'active'
        elif kind in ('identity.grant.operation.completed', 'identity.grant.operation.aborted'):
            operation = state['grantOperations'][p['operationId']]
            assert operation['status'] == 'active'
            if kind.endswith('.completed'):
                operation.update(status='completed', completedAt=p['completedAt'])
            else:
                operation.update(status='aborted', abortedAt=p['abortedAt'], abortReason=p['reason'])
        elif kind == 'identity.session.started':
            assert p['sub'] in state['users'] and p['sessionId'] not in state['sessions']
            state['sessions'][p['sessionId']] = {'sub': p['sub'], 'status': 'active'}
        elif kind == 'identity.session.ended':
            session = state['sessions'][p['sessionId']]
            assert session['status'] == 'active'
            session['status'] = 'ended'
        else:
            raise ValueError(f'Unknown identity event: {kind}')
    return state, types


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dump', type=Path)
    parser.add_argument('--expect')
    args = parser.parse_args()
    raw = args.dump.read_bytes()
    assert not raw or raw.endswith(b'\n'), 'truncated JSONL'
    records = [json.loads(line) for line in raw.splitlines()]
    state, types = reduce_identity(records)
    digest = hashlib.sha256(canonical(state)).hexdigest()
    result = {'dump': str(args.dump), 'records': len(records), 'offset': records[-1]['offset'] if records else '-1',
              'dumpSha256': hashlib.sha256(raw).hexdigest(), 'digest': digest, 'eventTypeCounts': types,
              'viewCounts': {key: len(value) for key, value in state.items()}}
    print(json.dumps(result, indent=2))
    if args.expect is not None:
        assert digest == args.expect, f'digest mismatch: observed {digest}, expected {args.expect}'


if __name__ == '__main__':
    main()
