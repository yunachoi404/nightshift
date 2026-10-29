import hashlib,json,pathlib,subprocess
root=pathlib.Path('outputs/qa-quick-shots/app/projects')
ids=['prj_mvhpes7hd504811a2b','prj_mvhph0hid78ba5d513','prj_mvhphpku9e812888b9','prj_mvhpjtrzde9c9aba6e']
def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name,width,height,nb_frames,sample_rate:format=duration','-of','json',str(path)],text=True))
def audio_hash(path):
    return subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-map','0:a:0','-c:a','pcm_s16le','-f','hash','-hash','sha256','-'],text=True).strip()
result=[]
for pid in ids:
    d=json.loads((root/pid/'project.json').read_text()); assets={a['id']:a for a in d['assets']}; takes={t['id']:t for t in d['takes']}
    p={'projectId':pid,'name':d['name'],'template':d['template'],'shotCount':len(d['shots']),'references':[{'label':r['label'],'kind':r['kind']} for r in d.get('references',[])],'takes':[],'exports':[]}
    for take in takes.values():
        asset=assets[take['videoAssetId']]; path=root/pid/asset['path']; t={'id':take['id'],'rung':take['rung'],'media':probe(path)}
        if take.get('parentTakeId'):
            parent=takes[take['parentTakeId']]; t['parentTakeId']=parent['id']; t['sameDecodedAudio']=audio_hash(path)==audio_hash(root/pid/assets[parent['videoAssetId']]['path'])
        p['takes'].append(t)
    for asset in d['assets']:
        if asset.get('role')=='export':
            path=root/pid/asset['path']; p['exports'].append({'assetId':asset['id'],'path':str(path),'media':probe(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    result.append(p)
pathlib.Path('research/qa/2026-10-21_quick_shots/media-checks.json').write_text(json.dumps(result,indent=2)+'\n')
print([(p['name'],len(p['takes']),len(p['exports'])) for p in result])
