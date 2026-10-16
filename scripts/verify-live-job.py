"""Verify an existing successful live probe via HTTP; does not call a model."""
import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('job_id')
parser.add_argument('--base', default='http://127.0.0.1:3000')
args = parser.parse_args()


def get(path, headers=None, text=False):
    request = urllib.request.Request(args.base + '/api' + path, headers=headers or {})
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read().decode() if text else json.load(response)


job = get('/jobs/' + urllib.parse.quote(args.job_id, safe=''))
assert job['state'] == 'completed' and job['error'] is None, 'job_not_successful'
result = get('/jobs/' + job['id'] + '/result')
snapshot = get('/snapshots/' + job['snapshot_id'])
assert result['kind'] == 'agent_probe', 'wrong_result_kind'
assert result['source_revision'] == snapshot['revision'], 'wrong_source_revision'
assert result['tool_calls'] >= 1 and result['reads'], 'no_observed_tool_call'
matched = False
for read in result['reads']:
    evidence = get('/snapshots/' + snapshot['id'] + '/evidence?' + urllib.parse.urlencode(read))
    if read['file'] == job['file']:
        assert evidence['content'] in result['answer'], 'answer_does_not_match_source'
        matched = True
assert matched, 'requested_file_not_read'

raw = get('/jobs/' + job['id'] + '/events', text=True)
events = []
for block in raw.split('\n\n'):
    lines = block.splitlines()
    identifier = next((int(line[4:]) for line in lines if line.startswith('id: ')), None)
    data = next((json.loads(line[6:]) for line in lines if line.startswith('data: ')), None)
    if identifier is not None and data is not None:
        events.append({'id': identifier, **data})
assert [e['id'] for e in events] == list(range(1, len(events) + 1)), 'event_sequence_gap'
types = [e['type'] for e in events]
for required in ('queued', 'started', 'tool_started', 'tool_finished', 'model_turn', 'completed'):
    assert required in types, 'missing_event_' + required
assert any(e['type'] == 'tool_finished' and not e['data']['is_error'] for e in events)
cursor = events[len(events) // 2]['id']
resumed = get('/jobs/' + job['id'] + '/events', headers={'Last-Event-ID': str(cursor)}, text=True)
resume_ids = [int(line[4:]) for line in resumed.splitlines() if line.startswith('id: ')]
assert resume_ids == [e['id'] for e in events if e['id'] > cursor], 'sse_resume_mismatch'

report = {
    'job_id': job['id'],
    'snapshot_id': snapshot['id'],
    'source_revision': snapshot['revision'],
    'state': job['state'],
    'source_content_verified': True,
    'sse_sequence_and_resume_verified': True,
    'tool_calls': result['tool_calls'],
    'usage': result['usage'],
    'event_types': types,
}
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/verified-live-job.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
