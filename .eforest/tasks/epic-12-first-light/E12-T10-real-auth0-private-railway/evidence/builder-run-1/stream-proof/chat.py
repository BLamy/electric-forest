#!/usr/bin/env python3
"""Independent chat-channel model and frozen-digest check; no product imports."""
import argparse
import hashlib
import json
from pathlib import Path
from identity import canonical


def replay(records):
    messages = []
    for index, event in enumerate(records):
        assert event['offset'] == f'{0:016d}_{index:016d}'
        kind, payload = event['type'], event['payload']
        assert kind in ('chat.message.post', 'chat.message.edit', 'chat.message.delete')
        previous = next((item for item in messages if item['id'] == payload['id']), None)
        if kind == 'chat.message.post':
            if previous is not None:
                continue
            parent = payload.get('threadOf')
            if parent is not None:
                assert any(item['id'] == parent and item['threadOf'] is None for item in messages)
            messages.append({'id': payload['id'], 'actor': payload['actor'], 'body': payload['body'], 'ts': event['ts'], 'offset': event['offset'], 'threadOf': parent, 'revision': 1, 'editedAt': None, 'deleted': False})
        elif previous is not None:
            if previous['deleted'] or previous['actor'] != payload['actor'] or previous['revision'] != payload['expectedRevision']:
                continue
            previous['revision'] += 1
            if kind == 'chat.message.edit':
                previous['body'] = payload['body']
                previous['editedAt'] = event['ts']
            else:
                previous['body'] = ''
                previous['deleted'] = True
    return {'messages': messages}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dump', type=Path)
    parser.add_argument('--expect')
    args = parser.parse_args()
    raw = args.dump.read_bytes()
    assert not raw or raw.endswith(b'\n'), 'truncated JSONL'
    records = [json.loads(line) for line in raw.splitlines()]
    value = hashlib.sha256(canonical(replay(records))).hexdigest()
    if args.expect:
        assert value == args.expect, (value, args.expect)
    print(json.dumps({'records': len(records), 'lastApplicationOffset': records[-1]['offset'] if records else '-1', 'digest': value, 'bytesSha256': hashlib.sha256(raw).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
