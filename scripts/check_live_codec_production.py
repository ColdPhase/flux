#!/usr/bin/env python3
"""Finite Docker-only proof of the exact current canonical codec; never installs dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def command(args, *, timeout=15, **kwargs):
    return subprocess.run(args, check=True, timeout=timeout, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capture_bounded(args, output, *, timeout, limit):
    """Keep a finite raw prefix; cap/deadline failure still tears down the actual child."""
    began = time.monotonic()
    deadline = began + timeout
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    retained = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                for key, _events in selector.select(min(.25, remaining)):
                    raw = os.read(key.fileobj.fileno(), min(4096, limit - retained + 1))
                    if not raw:
                        selector.unregister(key.fileobj)
                        continue
                    available = limit - retained
                    output.write(raw[:available])
                    retained += min(len(raw), available)
                    if len(raw) > available:
                        output.flush()
                        raise ValueError('Stage output exceeded its live capture ceiling; retained prefix is incomplete')
            code = child.wait(timeout=max(.001, deadline - time.monotonic()))
            if code:
                raise subprocess.CalledProcessError(code, args)
            return subprocess.CompletedProcess(args, code)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        child.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Existing source-labelled application test image; no build/install')
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    if os.environ.get('FLUX_LIVE_CALIBRATION_GRANTED') != '228':
        parser.error('Requires the explicit serial #228 Docker grant')
    repository = Path(__file__).resolve().parent.parent
    source = command(['git', 'rev-parse', 'HEAD'], cwd=repository, capture_output=True, text=True).stdout.strip()
    if not re.fullmatch('[a-f0-9]{40}', source):
        raise ValueError('Invalid actual source pin')
    if command(['git', 'status', '--porcelain'], cwd=repository, capture_output=True, text=True).stdout:
        raise ValueError('Run only a clean immutable candidate checkout')
    image = json.loads(command(['docker', 'image', 'inspect', args.image], capture_output=True, text=True).stdout)
    if len(image) != 1 or image[0]['Config'].get('Labels', {}).get('com.flux.commit') != source:
        raise ValueError('Existing image must carry this exact actual candidate source label')
    image_id = image[0]['Id']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id):
        raise ValueError('Invalid actual image id')
    evidence = args.evidence.resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    candidate = repository / 'app/tooling/live-codec-production-test'
    canonical = repository / 'app/apps/server/src/editing/codec'
    inputs = json.loads((candidate / 'candidate-inputs.json').read_text())
    expected_modules = {'caps.mjs', 'codec.mjs', 'envelope.mjs', 'assembly.mjs', 'admission-budget.mjs', 'worker-pool.mjs', 'codec-worker.mjs', 'room-cache.mjs'}
    if inputs['schema'] != 1 or set(inputs['canonicalModules']) != expected_modules:
        raise ValueError('Closed canonical source inventory required')
    expected_candidates = {'codec.test.mjs', 'wire-fixtures.mjs', 'intent-registry.mjs', 'stall-worker.mjs', 'silent-worker.mjs', 'exit-worker.mjs', 'inventory.mjs', 'independent-probe.proposed.test.mjs', 'retained-backing.test.mjs'}
    if set(inputs['candidateFiles']) != expected_candidates:
        raise ValueError('Closed candidate test inventory required')
    if set(inputs['dependencies']) != {'yjs', 'y-codemirror.next', '@codemirror/state', '@codemirror/view', 'y-protocols', 'lib0', 'ws'}:
        raise ValueError('Closed dependency inventory required')
    overlay = Path(tempfile.mkdtemp(prefix='flux228-canonical-codec-'))
    owned_containers = set()
    cleanup_errors = []
    exit_status = 0
    try:
        overlay.chmod(0o755)
        for folder, group in [(canonical, inputs['canonicalModules']), (candidate, inputs['candidateFiles'])]:
            for name, expected in group.items():
                if not re.fullmatch(r'[a-z.-]+\.mjs', name) or not re.fullmatch('[a-f0-9]{64}', expected):
                    raise ValueError('Invalid source manifest entry')
                if digest(folder / name) != expected:
                    raise ValueError(f'Changed pinned input {name}')
                shutil.copyfile(folder / name, overlay / name)
                (overlay / name).chmod(0o644)
        shutil.copyfile(candidate / 'candidate-inputs.json', overlay / 'candidate-inputs.json')
        (overlay / 'candidate-inputs.json').chmod(0o644)
        modules = overlay / 'node_modules'
        modules.mkdir(mode=0o755)
        modules.chmod(0o755)
        for name in inputs['dependencies']:
            package = 'server' if name == 'lib0' else 'web' if name != 'ws' else 'server'
            link = modules / name
            link.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            link.parent.chmod(0o755)
            link.symlink_to(f'/app/apps/{package}/node_modules/{name}', target_is_directory=True)
        (evidence / 'source-and-inputs.json').write_text(json.dumps({'sourceSha': source, 'imageId': image_id,
            'candidateInputsSha256': digest(candidate / 'candidate-inputs.json'), 'runnerSha256': digest(Path(__file__)), 'inputs': inputs}, indent=2) + '\n')

        def run_stage(stage, duration, node_arguments, output_name, output_limit):
            name = f'flux228-codec-{stage}-{uuid.uuid4().hex[:12]}'
            owned_containers.add(name)
            result = None
            try:
                with (evidence / output_name).open('wb') as output:
                    result = capture_bounded(['docker', 'run', '--name', name, '--init', '--network=none', '--read-only', '--log-driver=none',
                        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--memory-swap=512m',
                        '--cpus=2', '--pids-limit=64', '--user=node',
                        '-v', f'{overlay}:/app/apps/web/live-codec-falsification:ro,Z',
                        '-w', '/app/apps/web/live-codec-falsification', '-e', f'FLUX_LIVE_SOURCE_SHA={source}',
                        '-e', 'FLUX_CALIBRATION_ROOT=/app/apps/web/live-codec-falsification', image_id,
                        'node', *node_arguments], output, timeout=duration, limit=output_limit)
            finally:
                try:
                    raw = json.loads(command(['docker', 'inspect', name], capture_output=True, text=True).stdout)[0]
                    observation = {'imageId': raw['Image'], 'containerId': raw['Id'], 'state': raw['State'],
                        'memory': raw['HostConfig']['Memory'], 'memorySwap': raw['HostConfig']['MemorySwap'],
                        'nanoCpus': raw['HostConfig']['NanoCpus'], 'pidsLimit': raw['HostConfig']['PidsLimit'],
                        'readonlyRootfs': raw['HostConfig']['ReadonlyRootfs'], 'networkMode': raw['HostConfig']['NetworkMode'],
                        'capDrop': raw['HostConfig']['CapDrop'], 'securityOpt': raw['HostConfig']['SecurityOpt'],
                        'logDriver': raw['HostConfig']['LogConfig']['Type']}
                    (evidence / f'{stage}-container.json').write_text(json.dumps(observation, indent=2) + '\n')
                    if result is not None and (raw['State']['Running'] or raw['State']['OOMKilled'] or raw['State']['ExitCode'] != 0):
                        raise ValueError('Actual container did not exit cleanly')
                    if observation['imageId'] != image_id or observation['memory'] != 512 * 1024 * 1024 or observation['memorySwap'] != observation['memory'] or observation['nanoCpus'] != 2_000_000_000 or observation['pidsLimit'] != 64 or not observation['readonlyRootfs'] or observation['networkMode'] != 'none' or observation['logDriver'] != 'none':
                        raise ValueError('Actual isolated container budgets differ from the accepted fixture')
                finally:
                    command(['docker', 'rm', '-f', name], capture_output=True, text=True)
                    owned_containers.remove(name)
            return result

        run_stage('inventory', 30, ['inventory.mjs'], 'inventory.json', 1024 * 1024)
        run_stage('corpus', 120, ['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-timeout=90000',
            'codec.test.mjs', 'independent-probe.proposed.test.mjs', 'retained-backing.test.mjs'], 'codec.tap', 8 * 1024 * 1024)
        output = evidence / 'codec.tap'
        summary = {name: int(value) for name, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)$', output.read_text(), re.MULTILINE)}
        if summary != {'tests': 42, 'pass': 42, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}:
            raise ValueError('Every retained 31+10+1 control must pass without skips or cancellation')
    except BaseException:
        exit_status = 1
        raise
    finally:
        for name in owned_containers:
            try:
                command(['docker', 'rm', '-f', name], capture_output=True, text=True)
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        shutil.rmtree(overlay)
        (evidence / 'runner-result.json').write_text(json.dumps({'sourceSha': source, 'imageId': image_id,
            'exitStatus': exit_status, 'cleanupErrors': cleanup_errors,
            'meaning': 'Canonical codec corpus only; no SQL/DOM/RSS/four-gate acceptance'}, indent=2) + '\n')
        if cleanup_errors:
            raise RuntimeError('Exact owned-container cleanup incomplete')
    print(f'Canonical codec evidence: {evidence}')


if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise InterruptedError(f'Interrupted by signal {signum}')

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    main()
