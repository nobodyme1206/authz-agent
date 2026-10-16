"""Stage-one persistence and validation; model output never controls metadata."""
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import select
from jsonschema import ValidationError
from .contracts import validate_result
from .db import Snapshot, Stage1State, Stage1Api

EXTRACTOR_VERSION = 'spring-java-1'


def api_identifier(identity):
    return 'api-' + hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:24]


def records(db, job_id):
    return list(db.scalars(select(Stage1Api).where(Stage1Api.job_id == job_id).order_by(Stage1Api.api_id)))


def envelope(db, job, force_partial=False):
    state = db.get(Stage1State, job.id)
    if not state:
        return None
    apis = [row.record for row in records(db, job.id)]
    if not apis and not state.scan.get('index_complete'):
        return None
    snapshot = db.get(Snapshot, job.snapshot_id)
    partial = force_partial or not state.scan.get('index_complete') or bool(state.scan.get('diagnostics')) or any(a['unresolved'] for a in apis)
    return {'schema_version': '0.4', 'project_id': snapshot.project_id, 'source_revision': snapshot.revision,
            'run_id': job.id, 'stage': 1, 'status': 'partial' if partial else 'completed', 'data': {'apis': apis}}


def save_checkpoint(db, job, entries, scan, root):
    if job.kind != 'stage1_extract':
        raise HTTPException(422, 'not_stage1_job')
    state = db.get(Stage1State, job.id)
    if not state:
        state = Stage1State(job_id=job.id, extractor_version=EXTRACTOR_VERSION, scan={})
        db.add(state)
    if scan is not None:
        if scan.get('extractor_version') != EXTRACTOR_VERSION:
            raise HTTPException(422, 'extractor_version_mismatch')
        state.scan = scan
    snapshot = db.get(Snapshot, job.snapshot_id)
    if len(entries) > 50 or len(json.dumps(entries)) > 2 * 1024 * 1024:
        raise HTTPException(422, 'checkpoint_too_large')
    result = {'schema_version': '0.4', 'project_id': snapshot.project_id, 'source_revision': snapshot.revision,
              'run_id': job.id, 'stage': 1, 'status': 'partial', 'data': {'apis': [e.get('api') for e in entries]}}
    try:
        validate_result(result, Path(root) / job.snapshot_id)
    except (ValidationError, ValueError, KeyError, TypeError):
        raise HTTPException(422, 'invalid_stage1_record')
    for entry in entries:
        api, detail = entry['api'], entry.get('detail', {})
        identity = detail.get('identity', [])
        if len(identity) != 7 or identity[0] != snapshot.revision or identity[4] != api['path'] or identity[5] != api['method'] or api_identifier(identity) != api['api_id']:
            raise HTTPException(422, 'invalid_api_identity')
        row = db.get(Stage1Api, (job.id, api['api_id']))
        if row:
            row.record, row.detail = api, detail
        else:
            db.add(Stage1Api(job_id=job.id, api_id=api['api_id'], record=api, detail=detail))
    db.flush()
