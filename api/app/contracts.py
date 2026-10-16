import json, os
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(os.getenv('CONTRACT_ROOT', '/contracts'))

def validate_result(result, source_root=None, related=None):
    from .files import read_evidence
    stage = result.get('stage')
    if stage not in (1, 2, 3, 4): raise ValueError('invalid_stage')
    schema = json.loads((ROOT / f'stage-{stage}.schema.json').read_text())
    Draft202012Validator(schema).validate(result)
    data = result['data']
    positions = {}
    if related and related.get('source_revision') and result['source_revision'] != related['source_revision']:
        raise ValueError('source_revision_mismatch')
    if stage == 1:
        ids = [a['api_id'] for a in data['apis']]
        if len(ids) != len(set(ids)): raise ValueError('duplicate_api_id')
        for a in data['apis']:
            fields = [(f['location'], f['name']) for f in a['request_fields']]
            if len(fields) != len(set(fields)): raise ValueError('duplicate_field')
    else:
        related = related or {}
        operation_ids = [op['id'] for op in data.get('operations', [])]
        if len(operation_ids) != len(set(operation_ids)): raise ValueError('duplicate_operation_id')
        valid_ops = operation_ids if stage == 2 else related.get('operation_ids', [])
        if data['api_id'] not in related.get('api_ids', []): raise ValueError('unknown_api_id')
        for item in data.get('checks', []) + data.get('requirements', []):
            if any(f not in related.get('fields', []) for f in item['fields']): raise ValueError('unknown_field_reference')
            for op in item.get('operation_ids', []):
                if op not in valid_ops: raise ValueError('unknown_operation_reference')
        entries = data.get('checks', data.get('requirements', []))
        ids = [e['id'] for e in entries]
        if len(ids) != len(set(ids)): raise ValueError('duplicate_entry_id')
        for c in data.get('comparisons', []):
            if c['requirement_id'] not in related.get('requirement_ids', []): raise ValueError('unknown_requirement_reference')
            if any(i not in related.get('check_ids', []) for i in c['check_ids']): raise ValueError('unknown_check_reference')
            if c.get('operation_id') and c['operation_id'] not in related.get('operation_ids', []): raise ValueError('unknown_operation_reference')
    def walk(node):
        if isinstance(node, dict):
            if {'file', 'start_line', 'end_line'} <= node.keys():
                if node['end_line'] < node['start_line']: raise ValueError('invalid_evidence_range')
                if Path(node['file']).is_absolute() or '..' in Path(node['file']).parts or '\\' in node['file']: raise ValueError('invalid_evidence_path')
                if source_root: read_evidence(source_root, node['file'], node['start_line'], node['end_line'], positions)
            for v in node.values(): walk(v)
        elif isinstance(node, list):
            for v in node: walk(v)
    walk(data)
    if stage == 1 and source_root:
        for a in data['apis']: read_evidence(source_root, a['file'], a['line'], a['line'], positions)
    return result
