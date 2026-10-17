"""Immutable Stage 1 inputs and evidence-validated Stage 2 checkpoints."""
import copy
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from jsonschema import ValidationError
from .db import Job, Snapshot, Stage1Api, Stage2State
from .contracts import validate_result

ANALYZER_VERSION = 'authz-java-1.1.13'
TERMINAL = {'completed', 'failed', 'cancelled'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def prepare(db, snapshot_id, options):
    if set(options) - {'stage1_run_id', 'api_id', 'base_run_id'}:
        raise HTTPException(422, 'invalid_stage2_options')
    if any(not isinstance(options.get(k), str) or not options[k] for k in ('stage1_run_id', 'api_id')):
        raise HTTPException(422, 'stage2_source_required')
    if 'base_run_id' in options and (not isinstance(options['base_run_id'], str) or not options['base_run_id']):
        raise HTTPException(422, 'invalid_base_run_id')
    source = db.get(Job, options['stage1_run_id'])
    row = db.get(Stage1Api, (options['stage1_run_id'], options['api_id']))
    if not source or source.kind != 'stage1_extract' or source.state not in TERMINAL or source.snapshot_id != snapshot_id or not row:
        raise HTTPException(409, 'invalid_stage2_source')
    frozen = copy.deepcopy({'api': row.record, 'detail': row.detail})
    hash_ = digest(frozen)
    result = {**options, 'analyzer_version': ANALYZER_VERSION, 'input_hash': hash_}
    if options.get('base_run_id'):
        base = db.get(Job, options['base_run_id'])
        state = db.get(Stage2State, options['base_run_id'])
        if not base or base.kind != 'stage2_analyze' or base.state not in TERMINAL or base.snapshot_id != snapshot_id or not state or state.input_hash != hash_ or state.analyzer_version != ANALYZER_VERSION:
            raise HTTPException(409, 'incompatible_base_run')
    return result, frozen


def envelope(db, job, force_partial=False):
    state = db.get(Stage2State, job.id)
    if not state or state.data is None:
        return None
    snap = db.get(Snapshot, job.snapshot_id)
    partial = force_partial or not state.detail.get('analysis_complete') or bool(state.data['unresolved'])
    return {'schema_version': '0.4', 'project_id': snap.project_id, 'source_revision': snap.revision,
            'run_id': job.id, 'stage': 2, 'status': 'partial' if partial else 'completed', 'data': state.data}


def was_read(e, observed):
    cursor = e['start_line']
    for r in sorted((r for r in observed if r['file'] == e['file']), key=lambda r:r['start_line']):
        if r['start_line'] > cursor:
            break
        if r['end_line'] >= cursor:
            cursor = r['end_line'] + 1
        if cursor > e['end_line']:
            return True
    return False


def save_checkpoint(db, job, data, detail, root):
    if job.kind != 'stage2_analyze':
        raise HTTPException(422, 'not_stage2_job')
    state = db.get(Stage2State, job.id)
    if detail.get('analyzer_version') != ANALYZER_VERSION or detail.get('input_hash') != state.input_hash:
        raise HTTPException(422, 'stage2_version_mismatch')
    if len(json.dumps({'data': data, 'detail': detail})) > 1024 * 1024:
        raise HTTPException(422, 'checkpoint_too_large')
    if data is not None:
        api = state.source_input['api']
        snap = db.get(Snapshot, job.snapshot_id)
        wrapped = {'schema_version': '0.4', 'project_id': snap.project_id, 'source_revision': snap.revision,
                   'run_id': job.id, 'stage': 2, 'status': 'partial', 'data': data}
        try:
            validate_result(wrapped, Path(root) / job.snapshot_id, {'api_ids': [api['api_id']], 'fields': [f['location'] + ':' + f['name'] for f in api['request_fields']], 'source_revision': snap.revision})
            observed = detail.get('agent_observed', detail.get('observed', [])) if detail.get('analysis_complete') else detail.get('observed', [])
            for item in data['checks'] + data.get('operations', []) + ([data['operation']] if 'operation' in data else []):
                if not item['evidence']:
                    raise ValueError('empty_evidence')
                for e in item['evidence']:
                    if not was_read(e, observed):
                        raise ValueError('unread_evidence')
            if not data.get('operation') and not data.get('operations'):
                raise ValueError('no_observed_operation')
            upstream = api['unresolved']
            for issue in upstream:
                if 'Stage 1: ' + issue not in data['unresolved']:
                    raise ValueError('upstream_issue_dropped')
            if detail.get('mandatory_unresolved') and not set(detail['mandatory_unresolved']) <= set(data['unresolved']):
                raise ValueError('navigation_issue_dropped')
            audit = detail.get('audit')
            if detail.get('analysis_complete') and audit is not None:
                if not set(audit.get('mandatory_unresolved', [])) <= set(data['unresolved']):
                    raise ValueError('audit_issue_dropped')
                for check in data['checks']:
                    if len(data.get('operations', [])) > 1 and not check.get('operation_ids'):
                        raise ValueError('operation_scope_required')
                    if audit.get('condition_dependencies') and 'jwt' in check['rule'].lower() and not check.get('conditions'):
                        raise ValueError('runtime_condition_required')
        except (ValidationError, ValueError, KeyError, TypeError):
            raise HTTPException(422, 'invalid_stage2_record')
        state.data = data
    state.detail = detail
    db.flush()
