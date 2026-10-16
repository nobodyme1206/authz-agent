import copy
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text, inspect
from app.db import Base, engine
from app.main import app, SOURCES
from app.stage1 import EXTRACTOR_VERSION, api_identifier
from app.migrations import upgrade

H={'X-Worker-Token':'test-internal-token'}
@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    with TestClient(app) as c: yield c

def setup(c):
    source=SOURCES/'stage';source.mkdir(exist_ok=True)
    (source/'A.java').write_text('class A {}\nsecond line\n')
    p=c.post('/api/projects',json={'name':'Stage','source':'stage'}).json()
    snap=c.post('/api/projects/'+p['id']+'/snapshots').json()
    c.post('/internal/worker/start',headers=H,json={'boot':'stage-boot'})
    return p,snap

def create(c,snap,**options):
    response=c.post('/api/jobs',json={'kind':'stage1_extract','snapshot_id':snap['id'],'options':options})
    assert response.status_code==201,response.text
    job=response.json()
    assert c.post('/internal/jobs/claim',headers=H,json={'boot':'stage-boot'}).json()['id']==job['id']
    return job

def entry(snap,path='/x',unresolved=None):
    identity=[snap['revision'],'A.java','p.A','run()',path,'ANY','{}']
    api={'api_id':api_identifier(identity),'method':'ANY','path':path,'file':'A.java','line':1,'request_fields':[{'name':'id','location':'body','type':'string','evidence':[{'file':'A.java','start_line':1,'end_line':1}]}],'unresolved':unresolved or []}
    return {'api':api,'detail':{'identity':identity,'controller_file':'A.java','handler':'p.A.run()','enrichment_status':'not_needed'}}

def checkpoint(c,j,entries,complete=True):
    return c.post('/internal/jobs/'+j['id']+'/stage1/checkpoints',headers=H,json={'boot':'stage-boot','entries':entries,'scan':{'extractor_version':EXTRACTOR_VERSION,'index_complete':complete,'phase':'finished','files':[{'file':'A.java','status':'parsed'}],'diagnostics':[]}})

def test_stage1_large_results_pagination_and_metadata(client):
    p,s=setup(client);j=create(client,s)
    entries=[entry(s,'/x/'+str(i)) for i in range(100)]
    for e in entries:e['api']['request_fields'][0]['note']='large result '+('x'*1000)
    assert checkpoint(client,j,entries[:50]).status_code==200
    assert checkpoint(client,j,entries[50:]).status_code==200
    r=client.post('/internal/jobs/'+j['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'})
    assert r.status_code==200,r.text
    result=client.get('/api/jobs/'+j['id']+'/result').json()
    assert len(json.dumps(result))>65536 and len(result['data']['apis'])==100
    assert result['project_id']==p['id'] and result['source_revision']==s['revision'] and result['run_id']==j['id']
    assert result['status']=='completed'
    page=client.get('/api/jobs/'+j['id']+'/apis',params={'limit':7,'page':2,'method':'ANY'}).json()
    assert len(page['items'])==7 and page['total']==100
    assert client.get('/api/jobs/'+j['id']+'/apis/'+entries[0]['api']['api_id']).status_code==200
    assert client.get('/api/jobs/'+j['id']+'/apis',params={'unresolved':True}).json()['total']==0
    reused=client.post('/api/jobs',json={'kind':'stage1_extract','snapshot_id':s['id'],'options':{'base_run_id':j['id'],'enrich':True}})
    assert reused.status_code==201
    client.post('/internal/jobs/claim',headers=H,json={'boot':'stage-boot'})
    base=client.post('/internal/jobs/'+reused.json()['id']+'/stage1/base',headers=H,json={'boot':'stage-boot'}).json()
    assert len(base)==100

def test_partial_results_survive_cancel_and_restart(client):
    _,s=setup(client);j=create(client,s)
    assert checkpoint(client,j,[entry(s,unresolved=['unknown'])],False).status_code==200
    client.post('/api/jobs/'+j['id']+'/cancel')
    r=client.post('/internal/jobs/'+j['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'})
    assert r.json()['state']=='cancelled'
    assert client.get('/api/jobs/'+j['id']+'/result').json()['status']=='partial'
    j=create(client,s);checkpoint(client,j,[entry(s)],False)
    client.post('/internal/worker/start',headers=H,json={'boot':'new-boot'})
    assert client.get('/api/jobs/'+j['id']).json()['error']=='worker_interrupted'
    assert client.get('/api/jobs/'+j['id']+'/result').json()['status']=='partial'
    assert client.post('/internal/jobs/'+j['id']+'/stage1/checkpoints',headers=H,json={'boot':'stage-boot','entries':[]}).status_code==409

def test_invalid_identity_source_options_and_incomplete_finish(client):
    _,s=setup(client);j=create(client,s)
    assert client.post('/internal/jobs/'+j['id']+'/finish',headers=H,json={'boot':'stage-boot','state':'completed'}).status_code==422
    bad=entry(s);bad['api']['api_id']='made-up'
    assert checkpoint(client,j,[bad]).status_code==422
    bad=entry(s);bad['api']['file']='../secret'
    assert checkpoint(client,j,[bad]).status_code==422
    bad=entry(s);bad['api']['request_fields'][0]['evidence'][0]['end_line']=100
    assert checkpoint(client,j,[bad]).status_code==422
    for options in ({'include_paths':['../']},{'enrich':'yes'},{'unknown':True}):
        assert client.post('/api/jobs',json={'kind':'stage1_extract','snapshot_id':s['id'],'options':options}).status_code==422
    assert client.post('/api/jobs',json={'kind':'stage1_extract','snapshot_id':s['id'],'options':{'base_run_id':j['id']}}).status_code==409

def test_explicit_migration_preserves_batch_one_rows(tmp_path):
    old=create_engine('sqlite:///'+str(tmp_path/'old.sqlite'))
    with old.begin() as c:
        c.execute(text('CREATE TABLE jobs (id VARCHAR PRIMARY KEY, snapshot_id VARCHAR, kind VARCHAR, state VARCHAR, file VARCHAR, worker VARCHAR, heartbeat DATETIME, result JSON, error TEXT, created_at DATETIME)'))
        c.execute(text("INSERT INTO jobs(id,kind,state,file,result) VALUES ('old','agent_probe','completed','A.java','{\"answer\":\"kept\"}')"))
    upgrade(old);upgrade(old)
    with old.connect() as c:
        row=c.execute(text("SELECT state,result,options FROM jobs WHERE id='old'")).one()
        assert row[0]=='completed' and json.loads(row[1])['answer']=='kept' and json.loads(row[2])=={}
        assert c.execute(text('SELECT count(*) FROM schema_migrations')).scalar()==1
    assert 'stage1_apis' in inspect(old).get_table_names()
