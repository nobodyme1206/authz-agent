import json,copy
from pathlib import Path
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.files import safe_path,read_evidence,snapshot_tree
from app.contracts import validate_result
from app.db import Base,engine,Session,Job,now
from app.main import app,SOURCES,SNAPSHOTS
from datetime import timedelta
from jsonschema import ValidationError

@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    with TestClient(app) as c: yield c

def prepare(client):
    source=SOURCES/'sample';source.mkdir(exist_ok=True)
    (source/'A.java').write_text('class A {}\nsecond line\n')
    p=client.post('/api/projects',json={'name':'Sample','source':'sample'}).json()
    s=client.post(f'/api/projects/{p["id"]}/snapshots').json()
    return p,s

H={'X-Worker-Token':'test-internal-token'}
def boot(c,b='boot-1'):
    assert c.post('/internal/worker/start',headers=H,json={'boot':b,'model':{'configured':False}}).status_code==200

def test_snapshot_and_boundaries(tmp_path):
    root=tmp_path/'source';root.mkdir();(root/'a.txt').write_text('one\ntwo\n')
    (root/'node_modules').mkdir();(root/'node_modules'/'ignored').write_text('ignore')
    a,rev,manifest,_=snapshot_tree(root,tmp_path/'store')
    b,rev2,_,_=snapshot_tree(root,tmp_path/'store')
    assert rev==rev2 and len(manifest)==1
    (root/'a.txt').write_text('changed')
    assert read_evidence(tmp_path/'store'/a,'a.txt',1,2)['content']=='one\ntwo'
    for rel in ('../a.txt','/etc/passwd','x/../../etc/passwd'):
        with pytest.raises(HTTPException): safe_path(root,rel)
    for start,end in ((0,1),(2,1),(1,500),(1,3)):
        with pytest.raises(HTTPException): read_evidence(tmp_path/'store'/a,'a.txt',start,end)
    (root/'link').symlink_to('/etc/passwd')
    with pytest.raises(HTTPException): safe_path(root,'link')
    with pytest.raises(HTTPException): snapshot_tree(root,tmp_path/'store')

def test_approved_contracts_and_references():
    related={'api_ids':['api-001'],'fields':['body:newRoleId','body:userId','body:oldRoleId'],'requirement_ids':['req-1'],'check_ids':['check-1']}
    # Baseline uses an illustrative API id shared by stages 2-4.
    for i in range(1,5):
        r=json.loads(Path(f'/contracts/examples/stage-{i}.json').read_text())
        validate_result(r,related=related)
        bad=copy.deepcopy(r);bad['status']='running'
        with pytest.raises(ValidationError):validate_result(bad,related=related)
        bad=copy.deepcopy(r);bad.pop('source_revision')
        with pytest.raises(ValidationError):validate_result(bad,related=related)
    r=json.loads(Path('/contracts/examples/stage-4.json').read_text())
    r['data']['comparisons'][0]['check_ids']=['nonexistent']
    with pytest.raises(ValueError,match='unknown_check'):validate_result(r,related=related)
    r['data']['comparisons'][0]['result']='safe'
    with pytest.raises(ValidationError):validate_result(r,related=related)

def test_contract_source_positions(tmp_path):
    (tmp_path/'A.java').write_text('class A {}\n')
    r={'schema_version':'0.4','project_id':'p','source_revision':'v','run_id':'r','stage':1,'status':'completed','data':{'apis':[{'api_id':'a','method':'GET','path':'/a','file':'A.java','line':1,'request_fields':[],'unresolved':[]}]}}
    validate_result(r,tmp_path)
    r['data']['apis'][0]['line']=2
    with pytest.raises(HTTPException):validate_result(r,tmp_path)

def test_contract_context_and_multi_operation_references():
    stage1=json.loads(Path('/contracts/examples/stage-1.json').read_text())
    bad=copy.deepcopy(stage1);bad['data']['apis'][0]['line']='130'
    with pytest.raises(ValidationError):validate_result(bad)
    bad=copy.deepcopy(stage1)
    fields=bad['data']['apis'][0]['request_fields'];fields.append(copy.deepcopy(fields[0]))
    with pytest.raises(ValueError,match='duplicate_field'):validate_result(bad)
    with pytest.raises(ValueError,match='source_revision_mismatch'):
        validate_result(stage1,related={'source_revision':'another-snapshot'})
    stage2=json.loads(Path('/contracts/examples/stage-2.json').read_text())
    related={'api_ids':[stage2['data']['api_id']],'fields':stage2['data']['checks'][0]['fields']}
    operation=stage2['data'].pop('operation');operation['id']='op-add'
    stage2['data']['operations']=[operation]
    stage2['data']['checks'][0]['operation_ids']=['op-add']
    validate_result(stage2,related=related)
    stage2['data']['checks'][0]['operation_ids']=['op-missing']
    with pytest.raises(ValueError,match='unknown_operation_reference'):validate_result(stage2,related=related)
    stage2['data']['checks'][0]['operation_ids']=['op-add']
    stage2['data']['checks'][0]['evidence'][0]['file']='../secret'
    with pytest.raises(ValueError,match='invalid_evidence_path'):validate_result(stage2,related=related)

def test_api_register_snapshot_cancel_sse(client):
    p,s=prepare(client)
    assert client.post('/api/projects',json={'name':'x','source':'../'}).status_code==422
    assert client.get(f'/api/snapshots/{s["id"]}/evidence',params={'file':'../secret'}).status_code==422
    assert client.get(f'/api/snapshots/{s["id"]}/evidence',params={'file':'A.java','start_line':1,'end_line':2}).json()['content'].startswith('class A')
    j=client.post('/api/jobs',json={'snapshot_id':s['id'],'file':'A.java'}).json()
    client.post(f'/api/jobs/{j["id"]}/cancel')
    response=client.get(f'/api/jobs/{j["id"]}/events',headers={'Last-Event-ID':'1'})
    assert 'id: 2' in response.text and 'id: 1\n' not in response.text
    assert client.get(f'/api/jobs/{j["id"]}').json()['state']=='cancelled'
    assert client.get(f'/api/jobs/{j["id"]}/result').status_code==409
    assert client.post('/internal/jobs/claim',json={'boot':'x'}).status_code==401

def test_claim_finish_and_restart(client):
    _,s=prepare(client);boot(client)
    j=client.post('/api/jobs',json={'snapshot_id':s['id'],'file':'A.java'}).json()
    claim=client.post('/internal/jobs/claim',headers=H,json={'boot':'boot-1'}).json()
    assert claim['id']==j['id']
    assert client.post('/internal/jobs/claim',headers=H,json={'boot':'boot-1'}).json() is None
    response=client.post(f'/internal/jobs/{j["id"]}/finish',headers=H,json={'boot':'boot-1','state':'completed','result':{'kind':'agent_probe','reads':[]}})
    assert response.status_code==422
    boot(client,'boot-2')
    assert client.get(f'/api/jobs/{j["id"]}').json()['error']=='worker_interrupted'
    assert client.post(f'/internal/jobs/{j["id"]}/finish',headers=H,json={'boot':'boot-1','state':'failed'}).status_code==409
    j2=client.post('/api/jobs',json={'snapshot_id':s['id'],'file':'A.java'}).json()
    client.post('/internal/jobs/claim',headers=H,json={'boot':'boot-2'})
    with Session() as db:
        row=db.get(Job,j2['id']);row.heartbeat=now()-timedelta(seconds=100);db.commit()
    assert client.get(f'/api/jobs/{j2["id"]}').json()['state']=='failed'

def test_running_cancel_and_verified_evidence(client):
    _,s=prepare(client);boot(client)
    def claim_new():
        j=client.post('/api/jobs',json={'snapshot_id':s['id'],'file':'A.java'}).json()
        client.post('/internal/jobs/claim',headers=H,json={'boot':'boot-1'})
        return j
    j=claim_new();client.post(f'/api/jobs/{j["id"]}/cancel')
    assert client.post(f'/internal/jobs/{j["id"]}/heartbeat',headers=H,json={'boot':'boot-1'}).json()['state']=='cancel_requested'
    assert client.post(f'/internal/jobs/{j["id"]}/finish',headers=H,json={'boot':'boot-1','state':'failed'}).json()['state']=='cancelled'
    j=claim_new()
    payload={'kind':'agent_probe','reads':[{'file':'A.java','start_line':1,'end_line':1}],'answer':'class A {}'}
    assert client.post(f'/internal/jobs/{j["id"]}/finish',headers=H,json={'boot':'boot-1','state':'completed','result':payload}).status_code==200
    assert client.get(f'/api/jobs/{j["id"]}/result').json()==payload
