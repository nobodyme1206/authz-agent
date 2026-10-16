"""Read-only container/HTTP acceptance checks. Requires a running Compose stack."""
import json
import subprocess
import urllib.request
from pathlib import Path


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


report = {}
for service in ('web', 'api', 'agent-worker', 'db'):
    identifier = command('docker', 'compose', 'ps', '-q', service).strip()
    assert identifier, f'{service}: not running'
    info = json.loads(command('docker', 'inspect', identifier))[0]
    host = info['HostConfig']
    assert info['State']['Health']['Status'] == 'healthy', f'{service}: unhealthy'
    assert not host['Privileged'] and host['NetworkMode'] != 'host'
    assert all(m['Destination'] != '/var/run/docker.sock' for m in info['Mounts'])
    uid = command('docker', 'compose', 'exec', '-T', service, 'id', '-u').strip()
    assert uid != '0', f'{service}: root user'
    published = [p for ports in info['NetworkSettings']['Ports'].values() if ports for p in ports]
    if service == 'web':
        assert published and all(p['HostIp'] == '127.0.0.1' for p in published)
    else:
        assert not published, f'{service}: unexpected host port'
    report[service] = {'healthy': True, 'uid': uid, 'host_ports': published}
    if service != 'db':
        assert host['ReadonlyRootfs'], f'{service}: writable root filesystem'
    if service == 'agent-worker':
        assert host['NanoCpus'] > 0 and host['Memory'] > 0 and host['PidsLimit'] > 0
        assert all(m['Destination'] in ('/snapshots', '/runs') or m['Destination'].startswith('/run/secrets/') for m in info['Mounts'])
        snapshot = next(m for m in info['Mounts'] if m['Destination'] == '/snapshots')
        assert not snapshot['RW']
        # Access checks avoid creating any files even if a mount is misconfigured.
        command('docker', 'compose', 'exec', '-T', service, 'node', '-e',
                "const fs=require('fs');for(const p of ['/snapshots','/app']){let denied=false;try{fs.accessSync(p,fs.constants.W_OK)}catch{denied=true}if(!denied)process.exit(1)}")
    if service == 'api':
        source = next(m for m in info['Mounts'] if m['Destination'] == '/sources')
        assert not source['RW']
        command('docker', 'compose', 'exec', '-T', service, 'python', '-c',
                "import os; assert not os.access('/sources',os.W_OK)")

with urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=10) as response:
    report['health'] = json.load(response)
with urllib.request.urlopen('http://127.0.0.1:3000', timeout=10) as response:
    page = response.read().decode()
logs = command('docker', 'compose', 'logs', '--no-color')
public_payload = page + logs + json.dumps(report)
for file in Path('.secrets').iterdir():
    secret = file.read_text().strip()
    assert not secret or secret not in public_payload, 'secret exposed in ordinary logs/page/status'
report['secret_scan'] = 'passed'
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/runtime-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
