from pathlib import Path
import json,hashlib,base64,datetime,re
out=Path(__file__).resolve().parent;base=out.parent.parent/'evidence/run-2';records=[]
for stage in ['hosted-before','hosted-after']:
 b=json.loads((base/stage/'browser.json').read_text());n=json.loads((base/stage/'network.json').read_text());assert b['consoleErrors']==b['pageErrors']==b['requestFailures']==[];assert b['origin']=='https://electric-forest-preview-production.up.railway.app';assert b['revision']=='1f9e06b87109a93c75107842d4c8aa65902f8622';assert len(b['timeline'])==10
 accepted=next(s for s in b['timeline'] if s['name']=='two-profile-accepted');disconnected=next(s for s in b['timeline'] if s['name']=='witness-disconnected');reconnected=next(s for s in b['timeline'] if s['name']=='witness-reconnected');assert accepted['ms']<disconnected['ms']<reconnected['ms']
 posts=[x for x in n if x['path']=='/api/dispatch' and x['method']=='POST'];assert len(posts)==2 and all(x['status']==202 for x in posts)
 dump=[json.loads(l) for l in (base/stage/'witness-reconnected.jsonl').read_text().splitlines()]
 for p in posts:
  event=json.loads(p['body'])['event'];assert sum(e['payload'].get('body')==event['payload']['body'] for e in dump)==1
 nav=[x for x in n if x['role']=='grace' and x['path']=='/chat/preview/welcome'];posttime=posts[0]['ms'];assert not any(posttime<=x['ms']<=disconnected['ms'] for x in nav)
 assert not any('/proof' in x['path'] for x in n)
 assets=[x for x in n if x['path'].startswith('/assets/')];assert assets and all(x['status']==200 for x in assets)
 assert not [x for x in n if x['status']>=400 and x['status']!=401]
 records.append({'stage':stage,'timelineScenes':len(b['timeline']),'posts':posts,'isolatedWitnessNavigationCount':len(nav),'noWitnessReloadDuringLiveMutation':True,'assetResponseCount':len(assets),'allAssetStatuses200':True,'proofPollingRequests':0,'consolePageRequestErrors':0,'terminalLongPolls':len(b['terminalLongPolls']),'unauthenticated401Count':sum(x['status']==401 for x in n)})
s=json.loads((base/'hosted-supplement/supplement.json').read_text());assert s['consoleErrors']==s['pageErrors']==s['requestFailures']==[];assert 'value="agent"' not in s['memberDialogHtml']
for e in s['endpoints']:
 if e['path'] in ['/healthz','/readyz','/api/build']:assert e['status']==200 and e['body']['revision']=='1f9e06b87109a93c75107842d4c8aa65902f8622'
 elif '/auth/' in e['path'] or e['path'].startswith(('/streams','/admin')):assert e['status']==404
 else:assert e['status']==403
canary=json.loads((base/'final/canary-scan.json').read_text());assert canary['findings']==[];assert len(canary['files'])==555
manifest=json.loads((base/'railway/manifest.json').read_text());image=manifest['image'];assert json.loads(base64.b64decode(image['descriptorBase64']))==image['descriptor'];assert image['descriptor']['digest']==image['imageDigest']
iso=lambda s:datetime.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+',r'\1',s).replace('Z','+00:00'))
dt=(iso(manifest['restart']['newProcessReadyAt'])-iso(manifest['restart']['startedAt'])).total_seconds()*1000;assert abs(dt-manifest['restart']['requestToNewProcessReadyMs'])<1 and dt<60000
# Cross-bind each observed asset hash and byte count to the baked runtime file list.
files={f['path']:f for f in json.loads((base/'hosted-before/deployment.json').read_text())['artifact']['files']}
for row in canary['files']:
 item=files[row['artifactPath']];assert row['bakedSha256']==item['sha256'] and row['bakedSize']==item['size'];assert row['status']==200
 if row['path']!='/':assert row['sha256']==item['sha256'] and row['bytes']==item['size']
 else:assert row['normalization']=='remove exactly the declared server mode/build metadata pair'
summary={'hosted':records,'supplementEndpoints':s['endpoints'],'memberDialogHumanOnly':True,'preexistingFocusObservationExcluded':s['focusObservation'],'scan':{k:v for k,v in canary.items() if k!='files'},'imageDescriptorMatches':True,'restartRequestToNewProcessReadyMs':dt,'notes':'No hosted browser was driven. Seven MP4 contact sheets and notice/chat/human-only screenshot pixels were inspected, with source/timeline/network cross checks and independent replay.'}
(out/'browser-network-review.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({'stages':[{k:v for k,v in r.items() if k!='posts'} for r in records],'supplementEndpointCount':len(s['endpoints']),'restartMs':dt},indent=2))
