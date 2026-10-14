#!/usr/bin/env python3
"""TEST ONLY (#228): the inventory and sanitized runtime metadata of one latency run.

Called by scripts/check_live_editing.sh --latency after the enabled stack is healthy and before
the collector starts. Every value is an actual observation of this host, its Docker containers
and the candidate lockfile (docs/development/live-editing-verification.md); a missing
observation stops the run instead of becoming a zero. No environment values, cookies or
connection strings are recorded.
"""
import argparse, datetime, hashlib, json, os, platform, re, subprocess
from pathlib import Path

DEPENDENCIES = ('yjs', '@codemirror/state', '@codemirror/view', 'y-codemirror.next', 'ws')


def inspect(container):
    value = json.loads(subprocess.check_output(['docker', 'inspect', container], timeout=10))
    if not isinstance(value, list) or len(value) != 1:
        raise ValueError(f'one container expected for {container}')
    return value[0]


def limits(observed):
    host = observed['HostConfig']
    nano = host.get('NanoCpus') or 0
    quota, period = host.get('CpuQuota') or 0, host.get('CpuPeriod') or 0
    cpus = nano / 1e9 if nano > 0 else quota / period if quota > 0 and period > 0 else 'unset'
    memory = host.get('Memory') or 0
    pids = host.get('PidsLimit')
    return {'image': f"{observed['Config']['Image']} {observed['Image']}"[:512], 'cpus': cpus,
            'memory_bytes': memory if memory > 0 else 'unset', 'pids_limit': pids if isinstance(pids, int) and pids > 0 else 'unset'}


def locked_versions(lockfile):
    text = lockfile.read_text()
    found = {}
    for name in DEPENDENCIES:
        quoted = re.escape(f"'{name}@") if name.startswith('@') else re.escape(f'{name}@')
        versions = sorted(set(re.findall(rf'^  {quoted}([0-9][^:(\'\s]*)', text, re.M)))
        if len(versions) != 1:
            raise ValueError(f'exactly one locked version expected for {name}, found {versions}')
        found[name] = versions[0]
    return found


def first_line(path, key):
    for line in Path(path).read_text().splitlines():
        if line.startswith(key):
            return line.split(':', 1)[1].strip() if ':' in line else line.split('=', 1)[1].strip().strip('"')
    raise ValueError(f'{key} not found in {path}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--api', required=True, help='API container (inventoried as api-one)')
    parser.add_argument('--db', required=True)
    parser.add_argument('--db-user', required=True)
    parser.add_argument('--db-name', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if not re.fullmatch(r'[a-f0-9]{40}', args.source_sha):
        raise ValueError('exact source SHA required')
    driver = hashlib.sha256((root / 'app/tests/ui/live_editing_latency.py').read_bytes()).hexdigest()
    api, db = inspect(args.api), inspect(args.db)
    environment = api['Config']['Env']
    for required in ('FLUX_DEVELOPMENT_LIVE_EDITING=true', 'FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY=1',
                     'FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE=api-one'):
        if required not in environment:
            raise ValueError('the API container is not the enabled, inventoried telemetry producer')
    if not api['State']['Running']:
        raise ValueError('the API container is not running')
    inventory = {'schema': 1, 'source_sha': args.source_sha, 'driver_sha256': driver,
                 'api_instances': ['api-one'], 'containers': {'api-one': api['Id']}}
    version = subprocess.check_output(['docker', 'exec', args.db, 'psql', '-U', args.db_user, '-d', args.db_name, '-tAc', 'SHOW server_version'],
                                      timeout=10, text=True).strip()
    container_os = subprocess.check_output(['docker', 'exec', args.api, 'sh', '-c', '. /etc/os-release && echo "$PRETTY_NAME"'],
                                           timeout=10, text=True).strip()
    lockfile = root / 'app/pnpm-lock.yaml'
    memory_kib = int(first_line('/proc/meminfo', 'MemTotal').split()[0])
    runtime = {
        'source_sha': args.source_sha, 'driver_sha256': driver,
        'collected_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'hardware': {'cpu': first_line('/proc/cpuinfo', 'model name')[:512], 'logical_cores': os.cpu_count(), 'memory_bytes': memory_kib * 1024},
        'os': {'host': f"{first_line('/etc/os-release', 'PRETTY_NAME=')} {platform.release()}"[:2048], 'container': container_os[:2048]},
        'docker_limits': {'api-one': limits(api), 'db': limits(db)},
        'db': {'image': f"{db['Config']['Image']} {db['Image']}"[:2048], 'version': f'PostgreSQL {version}'[:2048]},
        'dependencies': {**locked_versions(lockfile), 'pnpm_lock_sha256': hashlib.sha256(lockfile.read_bytes()).hexdigest()},
        'network': {'condition': 'healthy-local',
                    'setup': 'One Docker Compose bridge network on one host: the Playwright container opens a loopback origin whose forwarder reaches api:8080; no induced loss, delay or WAN.'},
        'server_queue_evidence': {'path': 'actual-queue.jsonl', 'format': 'jsonl', 'source_sha': args.source_sha,
                                  'meaning': 'Bounded FLUX_LIVE_QUEUE records from the inventoried API stdout: initial, sampled wiki/map receipts and the terminal final with resource gauges and peaks.',
                                  'complete': False, 'api_instances': ['api-one']},
    }
    for name, value in (('queue-inventory.json', inventory), ('runtime.json', runtime)):
        raw = (json.dumps(value, sort_keys=True, indent=1) + '\n').encode()
        fd = os.open(args.evidence / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())


if __name__ == '__main__':
    main()
