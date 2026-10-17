from pathlib import Path
import json,hashlib,subprocess,base64
out=Path(__file__).resolve().parent;repo=out/'repo';base=out.parent.parent/'evidence/run-2'
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(v):return hashlib.sha256(canonical(v)).hexdigest()
def replay(events):
 state={'messages':[]}
 for e in events:
  assert e['type'] in ['chat.message.post','chat.message.edit','chat.message.delete']
  p=e['payload']; matches=[m for m in state['messages'] if m['id']==p['id']]
  if e['type']=='chat.message.post':
   if matches:continue
   if p.get('threadOf') is not None:
    assert any(m['id']==p['threadOf'] and m['threadOf'] is None for m in state['messages'])
   state['messages'].append({'id':p['id'],'actor':p['actor'],'body':p['body'],'ts':e['ts'],'offset':e.get('offset',''),'threadOf':p.get('threadOf'),'revision':1,'editedAt':None,'deleted':False})
  else:
   if not matches:continue
   m=matches[0]
   if m['deleted'] or m['actor']!=p['actor'] or m['revision']!=p['expectedRevision']:continue
   m['revision']+=1
   if e['type']=='chat.message.edit':m.update(body=p['body'],editedAt=e['ts'])
   else:m.update(body='',deleted=True)
 return state
records=[]
for p in sorted(base.glob('hosted-*/*.jsonl'))+[base/'http/accepted.jsonl']:
 raw=p.read_bytes();events=[json.loads(l) for l in raw.splitlines()];assert [e['offset'] for e in events]==[f'0000000000000000_{i:016d}' for i in range(len(events))]
 isfile=p.name=='file.jsonl'; reducer='file-content' if isfile else 'chat-channel'
 cmd=['node','packages/cli/dist/src/bin.js','replay',str(p),'--digest','--reducer',reducer]
 cli=[subprocess.check_output(cmd,cwd=repo,text=True).strip() for i in range(2)];assert cli[0]==cli[1]
 record={'path':str(p.relative_to(base)),'sha256':hashlib.sha256(raw).hexdigest(),'eventCount':len(events),'offset':events[-1]['offset'],'command':cmd,'cliDigests':cli}
 if isfile:
  write=[e for e in events if e['type']=='fs.file.write'][-1];content=base64.b64decode(write['payload']['contentBase64']);expected=(repo/'packages/platform/fixtures/preview/README.md').read_bytes();assert content==expected;sha=hashlib.sha256(content).hexdigest();assert sha==write['payload']['contentSha256']=='b8092b3115e9e787dc5b1d5b984ad16d2d638611e90402ecd4fdf0000650d5e5'
  record.update(independentBytesDigest=sha,fullStateCliDigestDistinctFromDOM=True)
 else:
  state=replay(events);own=digest(state);assert cli[0]==own;record['independentPythonDigest']=own
  if p.parent.name.startswith('hosted-'):
   timeline=json.loads((p.parent/'browser.json').read_text())['timeline'];step=next(s for s in timeline if s.get('dump')==p.name);assert step['offset']==events[-1]['offset'];assert own==step['digest'];assert all(s['digest']==own and s['offset']==events[-1]['offset'] for s in step['states']); record['recordedDOMMatches']=True
  else:assert own==json.loads((base/'http/http.json').read_text())['digest']
 records.append(record)
before=(base/'hosted-before/witness-reconnected.jsonl').read_bytes();after=(base/'hosted-after/witness-reconnected.jsonl').read_bytes();assert after.startswith(before)
final=replay([json.loads(l) for l in after.splitlines()]);assert digest(final)=='6780c44343b29371bb7a82a012461772a665a49f977daa0fe14ba29fcdef3670'
welcome=sum(1 for m in final['messages'] if m['id']=='preview-welcome');assert welcome==1
mutated=after.replace(b'Welcome!',b'welcome!',1); assert len(mutated)==len(after) and sum(x!=y for x,y in zip(after,mutated))==1
mutpath=out/'one-byte-mutation.jsonl';mutpath.write_bytes(mutated);mutdigest=digest(replay([json.loads(l) for l in mutated.splitlines()]));cmd=['node','packages/cli/dist/src/bin.js','replay',str(mutpath),'--digest','--reducer','chat-channel'];assert subprocess.check_output(cmd,cwd=repo,text=True).strip()==mutdigest;assert mutdigest!=digest(final)
# Frozen digest assertion is the measuring apparatus under attack, with its expected value unchanged.
result={'predictionFile':'predictions.json','records':records,'persistence':{'prefixByteIdentical':True,'beforeEvents':len(before.splitlines()),'afterEvents':len(after.splitlines()),'prefixSHA256':hashlib.sha256(before).hexdigest(),'welcomeSeeds':welcome,'finalDigest':digest(final)},'oneByteSensitivity':{'path':mutpath.name,'byteChanges':1,'changedFrom':'W','changedTo':'w','baselineDigest':digest(final),'mutatedDigest':mutdigest,'frozenComparison':'red: mutated != frozen original; original == frozen original','cliCommand':cmd}}
(out/'independent-replay.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
