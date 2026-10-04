"""#228 fixed-denominator, continuous real-input two-user visible-paint driver.

Run in Docker against the isolated enabled candidate:
FLUX_LIVE_EDITING_TEST=1 FLUX_LIVE_SOURCE_SHA=<frozen SHA> \
FLUX_LIVE_EVIDENCE=/evidence FLUX_LIVE_RUNTIME_METADATA=/evidence/runtime.json \
python tests/ui/live_editing_latency.py

Each case has 30 warm-ups and 240 scheduled samples spaced 250ms, over 60 seconds.
Inputs continue between samples. Deadline is 1000ms including two requestAnimationFrames.
Every failure/timeout stays in the denominator with infinite latency. No overhead subtraction.
Wiki samples require the exact original UUID's real server ACK and a peer applied/rendered
sequence that covers that receipt, rather than a text-only marker. Map samples require the
same generation and gesture with a preview sequence covering that trusted pointer input.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import stat
import time
import uuid
from pathlib import Path

from test_live_editing import LiveFixture

INTERVAL = .250
DEADLINE = 1.000
SAMPLES = 240
WARMUPS = 30
QUEUE_RAW_NAME = 'actual-queue.jsonl'
MEASUREMENT_FINISHED_NAME = 'measurement-finished.json'
QUEUE_SEAL_NAME = 'queue-seal.json'
QUEUE_MAX_BYTES = 32 * 1024 * 1024
QUEUE_MAX_RECORDS = 65_536
QUEUE_LINE_BYTES = 4096
HANDOFF_BYTES = 4096
SEAL_WAIT_SECONDS = 15
QUEUE_GAUGES = (
    'gatePending','gateConnected','wikiConnections','wikiReading','wikiWriting','wikiCursorActive','wikiCursorPending',
    'assemblyCount','assemblyBytes','httpQueued','nativeQueued','wikiOutputQueued','admissionQueued',
    'codecLeases','codecWaiting','codecActive','wikiSqlActive','mapQueued','mapActive','mapSqlActive',
    'mapConnections','mapOperations','mapPendingMovement','mapPendingPresence','externalInputBytes','externalOutputBytes',
)
QUEUE_PEAKS = tuple('peak'+field[0].upper()+field[1:] for field in QUEUE_GAUGES)
QUEUE_RECORD_COUNTERS = ('attemptedRecords','retainedRecords','droppedRecords')
API_INSTANCE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
SHA40 = re.compile(r'[a-f0-9]{40}')
SHA256 = re.compile(r'[a-f0-9]{64}')


def exact_integer(value, low=0, high=2**53-1):
    return type(value) is int and low <= value <= high


def canonical_uuid(value):
    if not isinstance(value,str):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def strict_json(raw):
    def closed_pairs(pairs):
        value = {}
        for key,item in pairs:
            if key in value:
                raise ValueError('Duplicate JSON field')
            value[key] = item
        return value
    def constant(_value):
        raise ValueError('Non-finite JSON constant')
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('Non-finite JSON number')
        return number
    return json.loads(raw.decode('utf-8') if isinstance(raw,bytes) else raw,object_pairs_hook=closed_pairs,parse_constant=constant,parse_float=finite_float)


def read_regular(path, limit):
    """Never follow a handoff/raw symlink, block on a FIFO, or read past the finite limit."""
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('Bounded regular evidence file required')
        raw = stream.read(limit+1)
        after = os.fstat(stream.fileno())
        named = os.stat(path,follow_symlinks=False)
        if len(raw) > limit or len(raw) != after.st_size or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or (named.st_dev,named.st_ino) != (after.st_dev,after.st_ino) or not stat.S_ISREG(named.st_mode):
            raise ValueError('Evidence file changed while being read')
    return raw


def atomic_handoff(directory, name, value):
    raw = (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
    if len(raw) > HANDOFF_BYTES:
        raise ValueError('Local handoff exceeds its finite bound')
    temporary = directory / ('.'+name+'.'+uuid.uuid4().hex+'.tmp')
    fd = os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary,directory/name)
    finally:
        temporary.unlink(missing_ok=True)
    return raw


def api_inventory(value):
    return isinstance(value,list) and 1 <= len(value) <= 32 and all(isinstance(item,str) and API_INSTANCE.fullmatch(item) for item in value) and len(set(value)) == len(value)


def distribution(values):
    ordered = sorted(values)
    def rank(fraction):
        value = ordered[max(0, math.ceil(fraction * len(ordered)) - 1)] if ordered else None
        return value if value is not None and math.isfinite(value) else None
    return {"count": len(ordered), "p50_ms": rank(.50), "p95_ms": rank(.95),
            "max_ms": rank(1), "infinite_count": sum(not math.isfinite(value) for value in ordered)}


def runtime_metadata():
    path = os.environ.get("FLUX_LIVE_RUNTIME_METADATA")
    if not path:
        raise RuntimeError("Candidate-pinned sanitized FLUX_LIVE_RUNTIME_METADATA is required before measurement")
    raw = read_regular(Path(path),65_536)
    value = strict_json(raw)
    required = {"source_sha", "driver_sha256", "collected_at", "hardware", "os", "docker_limits", "db", "dependencies", "network", "server_queue_evidence"}
    if not isinstance(value, dict) or set(value) != required:
        raise RuntimeError("Closed sanitized runtime metadata schema required")
    if value["source_sha"] != os.environ["FLUX_LIVE_SOURCE_SHA"] or not isinstance(value['source_sha'],str) or not SHA40.fullmatch(value["source_sha"]):
        raise RuntimeError("Runtime metadata does not match the exact candidate SHA")
    if value['driver_sha256'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise RuntimeError('The Docker image contains a different latency driver than the frozen candidate')
    if not isinstance(value['collected_at'],str) or not 1 <= len(value['collected_at']) <= 64:
        raise RuntimeError('Actual metadata collection timestamp required')
    schemas = {"hardware": {"cpu", "logical_cores", "memory_bytes"}, "os": {"host", "container"},
               "db": {"image", "version"}, "network": {"condition", "setup"}}
    for key, fields in schemas.items():
        if not isinstance(value[key], dict) or set(value[key]) != fields or any(item is None or item == "" for item in value[key].values()):
            raise RuntimeError(f"Actual sanitized {key} observations are required")
    hardware = value['hardware']
    if not isinstance(hardware['cpu'],str) or not 1 <= len(hardware['cpu']) <= 512 or not exact_integer(hardware['logical_cores'],1) or not exact_integer(hardware['memory_bytes'],1):
        raise RuntimeError('Observed CPU and positive hardware core/memory values required')
    if any(not isinstance(item,str) or not 1 <= len(item) <= 2048 for key in ('os','db','network') for item in value[key].values()):
        raise RuntimeError('Bounded actual OS/database/network descriptions required')
    if not isinstance(value["docker_limits"], dict) or not 1 <= len(value['docker_limits']) <= 32 or any(not isinstance(name,str) or not API_INSTANCE.fullmatch(name) for name in value['docker_limits']):
        raise RuntimeError("Actual Docker service limits are required")
    for item in value["docker_limits"].values():
        if not isinstance(item, dict) or set(item) != {"image", "cpus", "memory_bytes", "pids_limit"}:
            raise RuntimeError("Docker metadata may contain only image and explicit resource limits")
        if not isinstance(item['image'],str) or not 1 <= len(item['image']) <= 512 or item['cpus'] != 'unset' and (type(item['cpus']) not in (int,float) or not math.isfinite(item['cpus']) or item['cpus'] <= 0) or any(item[field] != 'unset' and not exact_integer(item[field],1) for field in ('memory_bytes','pids_limit')):
            raise RuntimeError('Docker limits need actual positive values or observed unset, never invented zero')
    dependencies = value["dependencies"]
    if not isinstance(dependencies, dict) or not dependencies or not re.fullmatch(r"[a-f0-9]{64}", str(dependencies.get("pnpm_lock_sha256", ""))):
        raise RuntimeError("Exact dependency versions and lockfile hash are required")
    if any(not isinstance(name,str) or not 1 <= len(name) <= 128 or not isinstance(item,str) or not 1 <= len(item) <= 256 for name,item in dependencies.items()):
        raise RuntimeError("Dependency metadata contains non-version fields")
    if not {"yjs", "@codemirror/state", "@codemirror/view", "y-codemirror.next", "ws", "pnpm_lock_sha256"}.issubset(dependencies):
        raise RuntimeError("Exact collaboration/transport dependency pins are required")
    evidence = value['server_queue_evidence']
    if not isinstance(evidence, dict) or set(evidence) != {'path','format','source_sha','meaning','complete','api_instances'} or evidence['path'] != QUEUE_RAW_NAME or evidence['format'] != 'jsonl' or evidence['source_sha'] != value['source_sha'] or evidence['complete'] is not False or not isinstance(evidence['meaning'],str) or not 1 <= len(evidence['meaning']) <= 512 or not api_inventory(evidence['api_instances']):
        raise RuntimeError('Closed source-pinned actual queue evidence descriptor required')
    value["metadata_sha256"] = hashlib.sha256(raw).hexdigest()
    return value


def container_environment():
    def bounded_file(path):
        try:
            return Path(path).read_text()[:4096].strip()
        except OSError:
            return None
    return {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(),
            "python_playwright": importlib.metadata.version("playwright"), "logical_cpus": os.cpu_count(),
            "cgroup_cpu_max": bounded_file("/sys/fs/cgroup/cpu.max"),
            "cgroup_memory_max": bounded_file("/sys/fs/cgroup/memory.max"),
            "cgroup_pids_max": bounded_file("/sys/fs/cgroup/pids.max"),
            "os_release": bounded_file("/etc/os-release")}


def frame_match(fixture, account, direction, predicate):
    return next((row for row in fixture.frames[account] if row["direction"] == direction and predicate(row["header"])), None)


def publication_ledger(fixture, start, end):
    keep = {"type", "kind", "operation", "uuid", "commandId", "generation", "sequence", "hash", "fingerprint", "changed",
            "workspace", "room", "replica", "parameters", "workspaceId", "resourceId", "gestureId", "leaseId",
            "deliveryId", "index", "count", "connectionId", "actor", "cursor", "selected", "code", "outcome", "retryable"}
    ledger = []
    for account in ("ada", "kai"):
        for row in fixture.frames[account]:
            if start <= row["at"] <= end:
                ledger.append({"account": account, "at": row["at"], "direction": row["direction"],
                               "header": {key: value for key, value in row["header"].items() if key in keep}})
    return sorted(ledger, key=lambda row: row["at"])


def validated_rows(directory, planned, source_sha):
    """Count retained schema-valid rows, including failures, never loop attempts."""
    completed, written, errors = 0, 0, []
    for case in planned:
        path = directory / f'{case}-rows.json'
        try:
            rows = strict_json(read_regular(path,64*1024*1024))
            if not isinstance(rows,list) or len(rows) > SAMPLES:
                raise ValueError('Bounded scheduled row array required')
            indices, valid = set(), 0
            for row in rows:
                if not isinstance(row,dict) or row.get('case') != case or row.get('source_sha') != source_sha or not exact_integer(row.get('index'),0,SAMPLES-1) or row['index'] in indices or type(row.get('deadline_ms')) is not int or row['deadline_ms'] != 1000 or row.get('outcome') not in ('painted','superseded-covered','error','timeout') or not canonical_uuid(row.get('workspace_id')) or not canonical_uuid(row.get('resource_id')) or not isinstance(row.get('accounts'),dict) or set(row['accounts']) != {'producer','receiver'} or any(not canonical_uuid(account) for account in row['accounts'].values()) or any(type(row.get(field)) not in (int,float) or not math.isfinite(row[field]) or row[field] < 0 for field in ('scheduled_at','observed_at')):
                    raise ValueError('Scheduled row identity/schema is invalid')
                latency = row.get('latency_ms')
                if row['outcome'] in ('painted','superseded-covered'):
                    if type(latency) not in (int,float) or not math.isfinite(latency) or not 0 <= latency <= 1000:
                        raise ValueError('Painted scheduled row has invalid/deadline-exceeding latency')
                elif latency is not None:
                    raise ValueError('Error/timeout row must retain infinite-latency representation')
                indices.add(row['index']); valid += 1
            written += valid
            if valid == SAMPLES and indices == set(range(SAMPLES)):
                completed += 1
            else:
                errors.append({'case':case,'error':'Scheduled rows are incomplete','valid_rows':valid})
        except FileNotFoundError:
            errors.append({'case':case,'error':'Rows artifact absent'})
        except Exception as error:
            errors.append({'case':case,'error':str(error)})
    return {'completed_case_count':completed,'scheduled_rows_written':written,'errors':errors}


def validate_finished(raw, metadata, planned):
    marker = strict_json(raw)
    fields = {'schema','measurement_id','source_sha','driver_sha256','api_instances','planned_cases','completed_case_count','scheduled_rows_written','teardown_complete','finished_at'}
    if not isinstance(marker,dict) or set(marker) != fields or type(marker['schema']) is not int or marker['schema'] != 1 or not canonical_uuid(marker['measurement_id']) or marker['source_sha'] != metadata['source_sha'] or marker['driver_sha256'] != metadata['driver_sha256'] or marker['planned_cases'] != planned or not api_inventory(marker['api_instances']) or marker['api_instances'] != metadata.get('server_queue_evidence',{}).get('api_instances',[]) or not exact_integer(marker['completed_case_count'],0,len(planned)) or not exact_integer(marker['scheduled_rows_written'],0,len(planned)*SAMPLES) or type(marker['teardown_complete']) is not bool or type(marker['finished_at']) not in (int,float) or not math.isfinite(marker['finished_at']) or marker['finished_at'] < 0:
        raise ValueError('Closed source/driver/inventory-pinned measurement marker required')
    return marker


async def await_queue_seal(directory):
    deadline = time.perf_counter()+SEAL_WAIT_SECONDS
    while time.perf_counter() < deadline:
        try:
            return read_regular(directory/QUEUE_SEAL_NAME,HANDOFF_BYTES)
        except FileNotFoundError:
            await asyncio.sleep(min(.1,max(0,deadline-time.perf_counter())))
    raise TimeoutError('Actual collector seal did not arrive within fifteen seconds')


def queue_evidence(metadata, directory, planned, finished_raw, seal_raw):
    descriptor = metadata.get('server_queue_evidence')
    if not descriptor:
        return {'status':'INCOMPLETE','reason':'Actual server queue-depth inventory/evidence was not supplied'}
    marker = validate_finished(finished_raw,metadata,planned)
    if read_regular(directory/MEASUREMENT_FINISHED_NAME,HANDOFF_BYTES) != finished_raw:
        raise ValueError('Published measurement marker changed')
    if read_regular(directory/QUEUE_SEAL_NAME,HANDOFF_BYTES) != seal_raw:
        raise ValueError('Published collector seal changed')
    row_coverage = validated_rows(directory,planned,metadata['source_sha'])
    if any(marker[field] != row_coverage[field] for field in ('completed_case_count','scheduled_rows_written')):
        raise ValueError('Measurement marker no longer agrees with actual row artifacts')
    seal = strict_json(seal_raw)
    fields = {'schema','measurement_id','source_sha','api_instances','measurement_finished_sha256','raw_path','raw_bytes','raw_sha256','record_count','complete','dropped_records','backpressured','final_drained','end_reason'}
    if not isinstance(seal,dict) or set(seal) != fields or type(seal['schema']) is not int or seal['schema'] != 1 or seal['measurement_id'] != marker['measurement_id'] or seal['source_sha'] != metadata['source_sha'] or seal['api_instances'] != marker['api_instances'] or seal['measurement_finished_sha256'] != hashlib.sha256(finished_raw).hexdigest() or seal['raw_path'] != QUEUE_RAW_NAME or not isinstance(seal['raw_sha256'],str) or not SHA256.fullmatch(seal['raw_sha256']) or not exact_integer(seal['raw_bytes'],1,QUEUE_MAX_BYTES) or not exact_integer(seal['record_count'],1,QUEUE_MAX_RECORDS) or not exact_integer(seal['dropped_records']) or any(type(seal[name]) is not bool for name in ('complete','backpressured','final_drained')) or seal['end_reason'] not in ('drained','collector-error','timeout','size-limit'):
        raise ValueError('Closed seal must bind this exact finished marker and producer inventory')
    path = directory/QUEUE_RAW_NAME
    raw = read_regular(path,QUEUE_MAX_BYTES)
    if len(raw) != seal['raw_bytes'] or hashlib.sha256(raw).hexdigest() != seal['raw_sha256'] or not raw.endswith(b'\n'):
        raise ValueError('Sealed raw bytes/hash/termination do not match')
    lines = raw[:-1].split(b'\n')
    if len(lines) != seal['record_count'] or len(lines) > QUEUE_MAX_RECORDS or any(not line or len(line)+1 > QUEUE_LINE_BYTES for line in lines):
        raise ValueError('Sealed exact line count/line bound does not match')
    numeric = set(QUEUE_GAUGES+QUEUE_PEAKS+QUEUE_RECORD_COUNTERS)
    required = numeric | {'schema','apiInstance','kind','resourceId','generation','backpressured'}
    optional = {'commandId','interactionId','inputSequence','confirmedSequence','finalDrained'}
    def correlation_key(resource, generation, identity, coverage):
        if not canonical_uuid(resource) or not canonical_uuid(generation):
            return None
        if canonical_uuid(identity.get('commandId')):
            return (resource,generation,'wiki',identity['commandId'])
        if canonical_uuid(identity.get('gestureId')) and exact_integer(coverage.get('publication_sequence')):
            return (resource,generation,'map',identity['gestureId'],coverage.get('publication_sequence'))
        return None
    rows_by_case, requested, matched_records = {}, set(), {}
    for case in planned:
        try:
            rows = strict_json(read_regular(directory/f'{case}-rows.json',64*1024*1024))
            if not isinstance(rows,list) or len(rows) > SAMPLES:
                continue
            rows_by_case[case] = rows
            for row in rows:
                if isinstance(row,dict):
                    identity, coverage = row.get('identity',{}), row.get('coverage',{})
                    if isinstance(identity,dict) and isinstance(coverage,dict):
                        key = correlation_key(row.get('resource_id'),identity.get('generation'),identity,coverage)
                        if key is not None:
                            requested.add(key)
        except (OSError,ValueError,TypeError):
            pass  # Partial/malformed measurement remains failed; telemetry can still drain.
    peaks, previous, finals, captured = {}, {}, {}, {}
    expected = set(marker['api_instances'])
    incomplete, budget_violations = False, {}
    for line in lines:
        record = strict_json(line)
        if not isinstance(record,dict) or not required.issubset(record) or set(record)-required-optional or type(record['schema']) is not int or record['schema'] != 1 or record['apiInstance'] not in expected or record['kind'] not in ('initial','wiki','map','final') or any(not exact_integer(record[field]) for field in numeric) or type(record['backpressured']) is not bool:
            raise ValueError('Closed primitive actual queue record/counters required')
        instance = record['apiInstance']
        if instance in finals or instance not in previous and record['kind'] != 'initial' or instance in previous and record['kind'] == 'initial':
            raise ValueError('Each inventoried producer needs one initial and one terminal final in order')
        if record['kind'] in ('initial','final'):
            if record['resourceId'] is not None or record['generation'] is not None or set(record)&(optional-{'finalDrained'}):
                raise ValueError('Initial/final telemetry cannot contain resource command fields')
        elif not canonical_uuid(record['resourceId']) or not canonical_uuid(record['generation']):
            raise ValueError('Actual queue resource/generation must be canonical UUIDs')
        if any(not canonical_uuid(record[field]) for field in ('commandId','interactionId') if field in record) or any(not exact_integer(record[field]) for field in ('inputSequence','confirmedSequence') if field in record):
            raise ValueError('Bounded queue command/interaction correlation required')
        if record['attemptedRecords'] != record['retainedRecords']+record['droppedRecords']:
            raise ValueError('Attempt/retained/drop counters must include this retained record')
        captured[instance] = captured.get(instance,0)+1
        if record['retainedRecords'] != captured[instance]:
            raise ValueError('A producer retained line was omitted, duplicated, or appended')
        old = previous.get(instance)
        if old and (any(record[field] < old[field] for field in QUEUE_PEAKS+QUEUE_RECORD_COUNTERS) or old['backpressured'] and not record['backpressured']):
            raise ValueError('Cumulative counters/peaks/backpressure cannot reset')
        for gauge,peak in zip(QUEUE_GAUGES,QUEUE_PEAKS):
            if record[peak] < record[gauge]:
                raise ValueError('Actual mutation-maintained peak is below its current gauge')
            peaks[peak] = max(peaks.get(peak,record[peak]),record[peak])
        incomplete |= record['droppedRecords'] > 0 or record['backpressured']
        for field in ('externalInputBytes','externalOutputBytes','peakExternalInputBytes','peakExternalOutputBytes','assemblyBytes','peakAssemblyBytes'):
            if record[field] > QUEUE_MAX_BYTES:
                incomplete = True
                key = f'{instance}:{field}'
                budget_violations[key] = max(budget_violations.get(key,0),record[field])
        if record['kind'] == 'final':
            if type(record.get('finalDrained')) is not bool:
                raise ValueError('An actual producer final-drained observation is required')
            if record['finalDrained'] and any(record[gauge] != 0 for gauge in QUEUE_GAUGES):
                raise ValueError('A producer cannot certify drain with retained resources')
            finals[instance] = record
        elif 'finalDrained' in record:
            raise ValueError('Only the terminal record can certify producer drain')
        if record['kind'] in ('wiki','map'):
            key = correlation_key(record['resourceId'],record['generation'],{'commandId':record.get('commandId'),'gestureId':record.get('interactionId')},{'publication_sequence':record.get('inputSequence')})
            if key in requested:
                matched_records[key] = record
        previous[instance] = record
    if set(finals) != expected:
        raise ValueError('A final from every initially inventoried API producer is required')
    dropped = sum(finals[instance]['droppedRecords'] for instance in expected)
    backpressured = any(finals[instance]['backpressured'] for instance in expected)
    drained = all(finals[instance]['finalDrained'] for instance in expected)
    if seal['dropped_records'] != dropped or seal['backpressured'] != backpressured or seal['final_drained'] != drained:
        raise ValueError('Seal cumulative drops/backpressure/drain disagree with actual producer finals')
    complete = drained and not incomplete and seal['end_reason'] == 'drained'
    if seal['complete'] != complete:
        raise ValueError('Seal completion cannot override actual raw producer observations')
    correlations = {}
    for case,rows in rows_by_case.items():
        correlated = []
        for row in rows:
            if not isinstance(row,dict):
                continue
            identity, coverage = row.get('identity',{}), row.get('coverage',{})
            if not isinstance(identity,dict) or not isinstance(coverage,dict):
                continue
            key = correlation_key(row.get('resource_id'),identity.get('generation'),identity,coverage)
            if key in matched_records:
                correlated.append({'index':row.get('index'),'server':matched_records[key]})
        correlation_path = directory/f'{case}-queue-correlations.json'
        correlation_path.write_text(json.dumps(correlated,indent=2,allow_nan=False))
        correlations[case] = {'scheduled_rows':len(rows),'correlated_rows':len(correlated),'unavailable_rows':len(rows)-len(correlated),'path':str(correlation_path)}
    # Per-row depth is optional in the contract; actual aggregate depth/peaks remain
    # mandatory. Null stays null where no correlation exists. No zero is invented.
    return {'status':'COMPLETE' if complete else 'INCOMPLETE','raw_path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),
            'record_count':len(lines),'api_instances':sorted(expected),'mutation_maintained_peaks':peaks,'finals':finals,
            'budget_violations':budget_violations,
            'seal':seal,'measurement_finished_sha256':hashlib.sha256(finished_raw).hexdigest(),'correlations':correlations,
            'clock':'Server admission snapshots are reported separately; they are never subtracted from the one driver-clock latency'}


async def painted(page, expression, arg):
    handle = await page.wait_for_function(expression, arg=arg, timeout=DEADLINE * 1000)
    first = await handle.json_value()
    condition_at = time.perf_counter()
    await page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    current = await page.evaluate(expression, arg)
    painted_at = time.perf_counter()
    if not current:
        raise RuntimeError("The correlated visible state did not survive both paint opportunities")
    return {"first_render": first, "render": current, "condition_at": condition_at, "painted_at": painted_at,
            "two_raf_and_recheck_ms": (painted_at - condition_at) * 1000}


async def cohort(fixture, case, owner, peer, producer, observer, local_observer, metadata):
    fixture.assertEqual(await owner.evaluate("document.visibilityState"), "visible")
    fixture.assertEqual(await peer.evaluate("document.visibilityState"), "visible")
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    await owner.context.tracing.start(screenshots=True, snapshots=True, sources=False)
    await peer.context.tracing.start(screenshots=True, snapshots=True, sources=False)
    stop = asyncio.Event()
    latest = {}
    errors = []
    input_times = []
    local_control = []
    for index in range(30):
        started = time.perf_counter()
        try:
            identity = await producer()
            observed = await asyncio.wait_for(local_observer(identity), DEADLINE)
            local_control.append({"index": index, "input_at": started, "identity": identity, **observed,
                                  "latency_ms": (observed['painted_at'] - started) * 1000, "outcome": "painted"})
        except Exception as error:
            local_control.append({"index": index, "input_at": started, "outcome": "error", "error": str(error), "latency_ms": None})
    async def inputs():
        while not stop.is_set():
            started = time.perf_counter()  # Before trusted keyboard/pointer dispatch.
            try:
                identity = await producer()
                input_times.append(started)
                latest.update({"input_at": started, "identity": identity})
            except Exception as error:
                errors.append(str(error))
            await asyncio.sleep(.016)
    task = asyncio.create_task(inputs())
    rows = []
    try:
        initial_deadline = time.perf_counter() + DEADLINE
        while not latest and time.perf_counter() < initial_deadline:
            await asyncio.sleep(.005)
        for index in range(WARMUPS):
            await asyncio.sleep(INTERVAL)
            if latest:
                try:
                    await asyncio.wait_for(observer({**latest["identity"], "input_at": latest["input_at"]}), DEADLINE)
                except Exception:
                    pass  # Warm-ups are excluded by a fixed, predeclared count only.
        schedule = time.perf_counter()
        rows = [None] * SAMPLES
        observations = []
        previous_input = None
        async def sample(index, scheduled, target, fresh):
            row = {"case": case, "index": index, "scheduled_at": scheduled, "observed_at": time.perf_counter(), "deadline_ms": 1000,
                   "accounts": {"producer": fixture.ada_id, "receiver": fixture.kai_id}, "workspace_id": fixture.workspace,
                   "resource_id": metadata["resource_id"], "source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], **(target or {})}
            if not target or not fresh:
                row.update(outcome="error", error="No fresh continuous trusted input identity", latency_ms=None)
            else:
                row["identity"] = dict(target["identity"])
                row["identity"]["input_at"] = target["input_at"]
                remaining = min(DEADLINE - (time.perf_counter() - target["input_at"]), scheduled + DEADLINE - time.perf_counter())
                try:
                    if remaining <= 0:
                        raise asyncio.TimeoutError("Input/scheduled observation already exceeded fixed deadline")
                    observation = await asyncio.wait_for(observer(row["identity"]), remaining)
                    row.update(observation)
                    row.update(outcome="superseded-covered" if observation["superseded"] else "painted",
                               latency_ms=(observation["painted_at"] - target["input_at"]) * 1000)
                except asyncio.TimeoutError:
                    row.update(outcome="timeout", latency_ms=None)
                except Exception as error:
                    row.update(outcome="error", error=str(error), latency_ms=None)
            rows[index] = row
        for index in range(SAMPLES):
            scheduled = schedule + index * INTERVAL
            await asyncio.sleep(max(0, scheduled - time.perf_counter()))
            target = dict(latest) if latest else None
            fresh = target is not None and target["input_at"] != previous_input
            previous_input = target["input_at"] if target else previous_input
            # At most four in-flight one-second observations. A slow/error sample never
            # postpones the next fixed 250ms sampling appointment or drops its row.
            observations.append(asyncio.create_task(sample(index, scheduled, target, fresh)))
        await asyncio.sleep(max(0, schedule + SAMPLES * INTERVAL - time.perf_counter()))
        await asyncio.gather(*observations)
    finally:
        stop.set()
        task.cancel()
        try:
            await asyncio.wait_for(task, 1)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        await owner.context.tracing.stop(path=str(directory / f"{case}-owner-trace.zip"))
        await peer.context.tracing.stop(path=str(directory / f"{case}-peer-trace.zip"))
    observation_end = time.perf_counter()
    ledger = publication_ledger(fixture, schedule, observation_end)
    publications = [row for row in ledger if row["direction"] == "sent" and (
        row["header"].get("type") in ("map-move", "cursor") or row["header"].get("operation") == "text" and row["header"].get("index") == 0)]
    publication_times = [row["at"] for row in publications]
    scheduled_inputs = [at for at in input_times if schedule <= at < schedule + SAMPLES * INTERVAL]
    socket_errors = [row for key in ("ada", "kai") for row in fixture.frames[key]
        if row["header"].get("type") in ("error", "resync", "revoked")]
    latencies = sorted(row["latency_ms"] if row["latency_ms"] is not None else math.inf for row in rows)
    p95 = latencies[math.ceil(.95 * SAMPLES) - 1]
    segment_names = {name for row in rows for name in row.get('segments',{})}
    summary = {"case": case, "source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "samples": len(rows), "warmups": WARMUPS,
        "interval_ms": 250, "duration_s": 60, "timeout_ms": 1000, "p95_ms": p95 if math.isfinite(p95) else None,
        "failures": sum(row["outcome"] not in ("painted", "superseded-covered") for row in rows), "input_errors": errors, "socket_errors": socket_errors,
        "superseded_count": sum(row["outcome"] == "superseded-covered" for row in rows),
        "scheduled_distribution": distribution(latencies),
        "finite_successful_distribution": distribution([row["latency_ms"] for row in rows if row["latency_ms"] is not None]),
        "segment_distributions": {name:{**distribution([row['segments'][name] for row in rows if name in row.get('segments',{})]),
            'unavailable_rows':sum(name not in row.get('segments',{}) for row in rows)} for name in sorted(segment_names)},
        "continuous_input": {"count": len(scheduled_inputs), "requested_sleep_ms": 16,
            "interval_distribution": distribution([(b-a)*1000 for a,b in zip(scheduled_inputs, scheduled_inputs[1:])])},
        "publications": {"count": len(publications), "interval_distribution": distribution([(b-a)*1000 for a,b in zip(publication_times, publication_times[1:])]),
            "by_type": {kind: sum(row["header"].get("type",row["header"].get("operation")) == kind for row in publications) for kind in ("map-move", "cursor", "text")},
            "cadence_by_type": {kind:distribution([(b-a)*1000 for a,b in zip(times,times[1:])]) for kind in ('map-move','cursor','text') for times in [[row['at'] for row in publications if row['header'].get('type',row['header'].get('operation')) == kind]]}},
        "local_render_control": {"samples": len(local_control), "distribution": distribution([row["latency_ms"] if row["latency_ms"] is not None else math.inf for row in local_control]), "subtracted": False},
        "queue_depth": {"client": "Per-row observed pending command count where the current UI exposes it",
                        "server": "External actual-runtime evidence required; no invented zero", "evidence": fixture.runtime_metadata.get("server_queue_evidence")},
        "fixture": metadata, "viewport": {"width": 1440, "height": 900}, "browser": owner.context.browser.version,
        "runtime_metadata": fixture.runtime_metadata, "container_observations": container_environment(),
        "browser_observations": {key: await page.evaluate("({visibility:document.visibilityState,hasFocus:document.hasFocus(),dpr:devicePixelRatio,visualViewportScale:visualViewport?.scale,rootCssZoom:getComputedStyle(document.documentElement).zoom,mapTransform:document.querySelector('.sk-plane')?getComputedStyle(document.querySelector('.sk-plane')).transform:null,viewport:{width:innerWidth,height:innerHeight}})") for key,page in (("owner",owner),("peer",peer))},
        "environment": {"origin": "same-origin isolated Docker fixture", "headless": True, "reduced_motion": True,
                        "clock": "one Python monotonic driver; browser round trips and two RAF included; no subtraction"}}
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{case}-rows.json").write_text(json.dumps(rows, indent=2))
    (directory / f"{case}-publications.json").write_text(json.dumps(ledger, indent=2))
    (directory / f"{case}-local-control.json").write_text(json.dumps(local_control, indent=2))
    (directory / f"{case}-coverage.json").write_text(json.dumps([{'index':row['index'],'outcome':row['outcome'],'identity':row.get('identity'),
        'coverage':row.get('coverage'),'publication_at':row.get('publication_at'),'receipt_at':row.get('receipt_at'),
        'painted_at':row.get('painted_at'),'latency_ms':row['latency_ms']} for row in rows],indent=2))
    (directory / f"{case}-summary.json").write_text(json.dumps(summary, indent=2))
    await peer.screenshot(path=str(directory / f"{case}-peer.png"), full_page=True)
    fixture.assertEqual(len(rows), 240)
    fixture.assertEqual(summary["failures"], 0, summary)
    fixture.assertEqual(errors, [], summary)
    fixture.assertEqual(socket_errors, [], summary)
    fixture.assertEqual(sum(row['outcome'] != 'painted' for row in local_control),0,summary)
    fixture.assertLessEqual(p95, 200, summary)
    return summary


async def wiki(fixture, units, reader):
    await fixture.create_doc("A" * (units - 1) + "B")
    owner, peer = fixture.pages["ada"], fixture.pages["kai"]
    field = await fixture.editor("ada")
    if reader:
        await peer.goto(fixture.doc_url)
        selector = "[data-live-reader]"
    else:
        await fixture.editor("kai")
        selector = "[data-live-wiki-editor]"
    await peer.locator(selector).wait_for()
    if reader:
        await peer.locator('.doc-prose').evaluate("el => el.scrollIntoView({block:'end'})")
    else:
        await peer.locator('.cm-content').click()
        await peer.keyboard.press('Control+End')
    await field.click()
    counter = 0
    async def produce():
        nonlocal counter
        await owner.keyboard.press("Control+End")
        await owner.keyboard.press("Shift+ArrowLeft")
        await owner.keyboard.insert_text(chr(97 + counter % 26))
        counter += 1
        identity = await owner.locator('[data-live-wiki-editor]').evaluate("el => {const status=document.querySelector('[data-live-status]')?.textContent||'', match=status.match(/^(\\d+) changes waiting to be shared/);return {inputRevision:Number(el.dataset.liveInputRevision),generation:el.dataset.liveGeneration,visibility:document.visibilityState,pending_commands:match?Number(match[1]):status.startsWith('All changes shared')?0:null};}")
        if not identity.get("inputRevision") or identity['visibility'] != 'visible':
            raise RuntimeError("Trusted editor input has no new local input revision")
        return identity
    async def observe(identity):
        match = await owner.wait_for_function("({revision,generation}) => {const el=document.querySelector('[data-live-wiki-editor]'); if (!el || el.dataset.liveGeneration!==generation) return false; const batch=JSON.parse(el.dataset.liveCommandBatches || '[]').find(batch => batch.from<=revision && batch.to>=revision); return batch ? {...batch,generation} : false;}", arg={"revision":identity["inputRevision"],"generation":identity["generation"]}, timeout=1000)
        batch = await match.json_value()
        sealed = {"commandId": batch["commandId"], "fromRevision": batch["from"], "coveringRevision": batch["to"], "generation": batch["generation"]}
        identity.update(sealed)
        until = time.perf_counter() + DEADLINE
        while identity["commandId"] not in fixture.acks["ada"]:
            if time.perf_counter() >= until:
                raise asyncio.TimeoutError("Original update receipt absent")
            await asyncio.sleep(.002)
        receipt = fixture.acks["ada"][identity["commandId"]]
        identity["sequence"] = receipt["sequence"]
        published = frame_match(fixture, 'ada', 'sent', lambda h: h.get('operation') == 'text' and h.get('uuid') == identity['commandId'] and h.get('index') == 0)
        acknowledged = frame_match(fixture, 'ada', 'received', lambda h: h.get('type') == 'ack' and h.get('commandId') == identity['commandId'])
        included = frame_match(fixture, 'kai', 'received', lambda h: h.get('type') == 'update' and h.get('commandId') == identity['commandId'] and h.get('generation') == identity['generation'] and h.get('sequence') == receipt['sequence'] and h.get('index') == h.get('count', 0)-1)
        if not published or not acknowledged:
            raise RuntimeError('Exact immutable publication and ACK were not recorded')
        while not included:
            if time.perf_counter() >= until:
                raise asyncio.TimeoutError('Exact update was not delivered into the peer confirmed stream')
            await asyncio.sleep(.002)
            included = frame_match(fixture, 'kai', 'received', lambda h: h.get('type') == 'update' and h.get('commandId') == identity['commandId'] and h.get('generation') == identity['generation'] and h.get('sequence') == receipt['sequence'] and h.get('index') == h.get('count', 0)-1)
        cursor_publication = cursor_receipt = None
        while not cursor_receipt:
            for row in fixture.frames['ada']:
                header = row['header']
                if row['direction'] == 'sent' and row['at'] >= identity['input_at'] and header.get('type') == 'cursor' and header.get('generation') == identity['generation'] and header.get('cursor'):
                    delivered = frame_match(fixture, 'kai', 'received', lambda h: h.get('type') == 'presence' and h.get('generation') == identity['generation'] and h.get('actor', {}).get('id') == fixture.ada_id and h.get('cursor') == header['cursor'])
                    if delivered:
                        cursor_publication, cursor_receipt = row, delivered
                        break
            if not cursor_receipt:
                if time.perf_counter() >= until:
                    raise asyncio.TimeoutError('A correlated named cursor was not published and received during typing')
                await asyncio.sleep(.002)
        expression = """({selector,generation,sequence,body,reader}) => {
          const el=document.querySelector(selector),content=document.querySelector(body);
          if(!el||!content||document.visibilityState!=='visible'||el.dataset.liveGeneration!==generation||Number(el.dataset.liveSequence)<sequence)return false;
          const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);let last=null,node;
          while((node=walker.nextNode()))if(node.length&&!node.parentElement.closest('.editing-caret'))last=node;
          if(!last)return false;
          const range=document.createRange();range.setStart(last,last.length-1);range.setEnd(last,last.length);
          const rect=range.getBoundingClientRect(),clip=content.closest('.cm-scroller')?.getBoundingClientRect();
          if(!(rect.width>0&&rect.height>0&&rect.top>=Math.max(0,clip?.top||0)&&rect.bottom<=Math.min(innerHeight,clip?.bottom||innerHeight)&&rect.left>=Math.max(0,clip?.left||0)&&rect.right<=Math.min(innerWidth,clip?.right||innerWidth)))return false;
          const name=reader?document.querySelector('.editing-people'):document.querySelector('.editing-caret[aria-label="Ada North\\'s cursor"]');
          if(!name||!name.textContent.includes('Ada North'))return false;
          if(!reader){const caret=name.getBoundingClientRect();if(caret.height<=0||Math.abs(caret.left-rect.right)>2||Math.abs(caret.top-rect.top)>rect.height)return false;}
          return {generation,sequence:Number(el.dataset.liveSequence),namedCursor:reader?'received named presence in ordinary reader':'visible named end cursor',characterRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
        }"""
        observed = await painted(peer, expression, {"selector": selector, "body": '.doc-prose' if reader else '.cm-content', "reader": reader, "generation": identity["generation"], "sequence": receipt["sequence"]})
        preview_receipt = None
        if reader:
            preview_receipt = frame_match(fixture, 'kai', 'received', lambda h: h.get('type') == 'preview' and h.get('generation') == identity['generation'] and h.get('sequence') == observed['render']['sequence'] and ('index' not in h or h.get('index') == h.get('count', 0)-1))
            if not preview_receipt:
                raise RuntimeError('Rendered reader preview has no matching complete authorized publication')
            rendered_update = frame_match(fixture, 'kai', 'received', lambda h: h.get('type') == 'update' and h.get('generation') == identity['generation'] and h.get('sequence') == observed['render']['sequence'] and h.get('index') == h.get('count',0)-1)
            if not rendered_update or rendered_update['header'].get('hash') != preview_receipt['header'].get('hash'):
                raise RuntimeError('Rendered reader preview does not match the complete confirmed update hash')
        observed.update(superseded=reader and observed['render']['sequence'] > receipt['sequence'],
            coverage={"kind": 'safe-reader-preview' if reader else 'contiguous-confirmed-head', "input_revision": identity['inputRevision'],
                      "sealed_batch": sealed, "receipt_sequence": receipt['sequence'], "render_sequence": observed['render']['sequence']},
            publication_at=published['at'], receipt_at=acknowledged['at'], peer_update_received_at=included['at'],
            receipt={name:receipt.get(name) for name in ('commandId','generation','sequence','hash','fingerprint','operation','changed','workspaceId','resourceId')},
            peer_preview_received_at=preview_receipt['at'] if preview_receipt else None,
            cursor={"published_at": cursor_publication['at'], "received_at": cursor_receipt['at'], "generation": identity['generation'],
                    "actor_id": fixture.ada_id, "relative_position": cursor_publication['header']['cursor']},
            segments={"input_to_publication_ms": (published['at']-identity['input_at'])*1000,
                      "publication_to_ack_ms": (acknowledged['at']-published['at'])*1000,
                      "input_to_ack_ms": (acknowledged['at']-identity['input_at'])*1000,
                      "peer_receipt_to_render_condition_ms": (observed['condition_at']-included['at'])*1000,
                      "two_raf_and_recheck_ms": observed['two_raf_and_recheck_ms']},
            queue_depth={"client_pending_commands": identity['pending_commands'], "observed_at": identity['input_at'], "server": None})
        return observed
    async def local_observe(identity):
        expression = """({generation,revision}) => {
          const el=document.querySelector('[data-live-wiki-editor]'),content=document.querySelector('.cm-content');
          if(!el||!content||document.visibilityState!=='visible'||el.dataset.liveGeneration!==generation||Number(el.dataset.liveInputRevision)<revision)return false;
          const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);let last=null,node;
          while((node=walker.nextNode()))if(node.length&&!node.parentElement.closest('.editing-caret'))last=node;
          if(!last)return false;const range=document.createRange();range.setStart(last,last.length-1);range.setEnd(last,last.length);
          const rect=range.getBoundingClientRect(),clip=content.closest('.cm-scroller').getBoundingClientRect();
          if(!(rect.width>0&&rect.height>0&&rect.top>=Math.max(0,clip.top)&&rect.bottom<=Math.min(innerHeight,clip.bottom)&&rect.left>=Math.max(0,clip.left)&&rect.right<=Math.min(innerWidth,clip.right)))return false;
          return {generation,inputRevision:Number(el.dataset.liveInputRevision),characterRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
        }"""
        return await painted(owner, expression, {"generation": identity['generation'], "revision": identity['inputRevision']})
    return await cohort(fixture, f"wiki-{units}-{'reader' if reader else 'editor'}", owner, peer, produce, observe,
                        local_observe, {"resource_id": fixture.doc_id, "body_units": units, "actions": "continuous native keyboard replace-one-character; length constant; changed final character stays in both viewports", "receiver": "ordinary reader sanitized HTML" if reader else "CodeMirror Yjs editor"})


async def map_drag(fixture, count, selected):
    await fixture.create_map(count)
    owner, peer = fixture.pages["ada"], fixture.pages["kai"]
    selected_thoughts = fixture.thoughts[:selected]
    for thought in selected_thoughts:
        await owner.locator(f'.sk-node[data-id="{thought["id"]}"]').click(modifiers=["Shift"])
    target = selected_thoughts[-1]
    node = owner.locator(f'.sk-node[data-id="{target["id"]}"]')
    peer_node = peer.locator(f'.sk-node[data-id="{target["id"]}"]')
    await node.scroll_into_view_if_needed()
    await peer_node.scroll_into_view_if_needed()
    box = await node.bounding_box()
    x, y = box["x"] + 20, box["y"] + 20
    await owner.mouse.move(x, y)
    await owner.mouse.down()
    counter = 0
    async def produce():
        nonlocal counter
        counter += 1
        await owner.mouse.move(x + 25 + 18 * math.sin(counter / 10), y + 20 + 12 * math.cos(counter / 10))
        identity = await owner.locator('.sk-canvas').evaluate("el => ({gestureId:el.dataset.liveOwnGesture,generation:el.dataset.liveGeneration,sequence:Number(el.dataset.liveOwnSequence),visibility:document.visibilityState})")
        if not identity.get("gestureId") or identity["sequence"] < 1 or identity['visibility'] != 'visible':
            raise RuntimeError("Trusted drag has no current authorized gesture/input sequence")
        return identity
    async def observe(identity):
        expression = """({id,thoughts,gestureId,generation,sequence}) => {
          if(document.visibilityState!=='visible')return false;
          let dx=null,dy=null,lease=null,preview=null;const positions=[];
          for(const base of thoughts){const el=document.querySelector('.sk-node[data-id="'+base.id+'"]');
            if(!el||el.dataset.liveGeneration!==generation||el.dataset.liveGesture!==gestureId||Number(el.dataset.livePreviewSequence)<sequence||Number(el.dataset.thoughtVersion)!==base.version)return false;
            const current=Number(el.dataset.livePreviewSequence),x=Number(el.dataset.thoughtX)-base.x,y=Number(el.dataset.thoughtY)-base.y;
            if(!Number.isFinite(x)||!Number.isFinite(y)||!el.dataset.liveLease)return false;
            if(dx!==null&&(dx!==x||dy!==y||lease!==el.dataset.liveLease||preview!==current))return false;
            dx=x;dy=y;lease=el.dataset.liveLease;preview=current;positions.push({id:base.id,x:Number(el.dataset.thoughtX),y:Number(el.dataset.thoughtY),version:Number(el.dataset.thoughtVersion)});
          }
          const target=document.querySelector('.sk-node[data-id="'+id+'"]'),canvas=document.querySelector('.sk-canvas');
          if(!target||!canvas)return false;const box=target.getBoundingClientRect(),clip=canvas.getBoundingClientRect();
          if(!(box.width>0&&box.height>0&&box.left>=Math.max(0,clip.left)&&box.right<=Math.min(innerWidth,clip.right)&&box.top>=Math.max(0,clip.top)&&box.bottom<=Math.min(innerHeight,clip.bottom)))return false;
          return {generation,gestureId,leaseId:lease,sequence:preview,positions,dx,dy,targetRect:{left:box.left,top:box.top,right:box.right,bottom:box.bottom}};
        }"""
        observed = {"id": target["id"], "thoughts": [{"id": thought["id"], "version": thought["version"], "x": thought["x"], "y": thought["y"]} for thought in selected_thoughts], **identity}
        result = await painted(peer, expression, observed)
        render = result['render']
        def matches(header, sequence):
            return header.get('type') == 'map-move' and header.get('generation') == identity['generation'] and header.get('gestureId') == identity['gestureId'] and header.get('leaseId') == render['leaseId'] and header.get('sequence') == sequence
        publication = frame_match(fixture, 'ada', 'sent', lambda h: matches(h,render['sequence']))
        receipt = frame_match(fixture, 'kai', 'received', lambda h: matches(h,render['sequence']))
        first_receipt = frame_match(fixture, 'kai', 'received', lambda h: matches(h,result['first_render']['sequence']))
        if not publication or not receipt or not first_receipt or receipt['header'].get('actor', {}).get('id') != fixture.ada_id:
            raise RuntimeError('Rendered group lacks its exact own publication and current server-named peer receipt')
        expected = {position['id']: (position['x'], position['y']) for position in publication['header']['positions']}
        authorized = {position['id']: (position['x'], position['y']) for position in receipt['header']['positions']}
        rendered = {position['id']: (position['x'], position['y']) for position in render['positions']}
        if len(expected) != selected or expected != authorized or authorized != rendered:
            raise RuntimeError('Every selected rendered position must equal the exact authorized publication')
        result.update(superseded=render['sequence'] > identity['sequence'],
            coverage={"kind": 'replaceable-same-gesture-preview', "generation": identity['generation'], "gesture_id": identity['gestureId'],
                      "lease_id": render['leaseId'], "input_sequence": identity['sequence'], "publication_sequence": publication['header']['sequence'],
                      "receipt_sequence": receipt['header']['sequence'], "render_sequence": render['sequence'], "selected_count": selected},
            publication_at=publication['at'], receipt_at=receipt['at'], commit_ack=None,
            segments={"input_to_covering_publication_ms": (publication['at']-identity['input_at'])*1000,
                      "publication_to_peer_receipt_ms": (receipt['at']-publication['at'])*1000,
                      "first_peer_receipt_to_render_condition_ms": (result['condition_at']-first_receipt['at'])*1000,
                      "covering_peer_receipt_to_painted_ms": (result['painted_at']-receipt['at'])*1000,
                      "two_raf_and_recheck_ms": result['two_raf_and_recheck_ms']},
            queue_depth={"client_pending_commands": None, "server": None, "meaning": 'Preview is replaceable; server queue depth is separate actual telemetry'})
        return result
    async def local_observe(identity):
        expression = """({generation,gestureId,sequence,thoughts,id}) => {
          if(document.visibilityState!=='visible')return false;
          const canvas=document.querySelector('.sk-canvas');if(!canvas||canvas.dataset.liveGeneration!==generation||canvas.dataset.liveOwnGesture!==gestureId||Number(canvas.dataset.liveOwnSequence)<sequence)return false;
          let dx=null,dy=null;for(const base of thoughts){const el=document.querySelector('.sk-node[data-id="'+base.id+'"]');if(!el||Number(el.dataset.thoughtVersion)!==base.version)return false;
            const x=Number(el.dataset.thoughtX)-base.x,y=Number(el.dataset.thoughtY)-base.y;if(!Number.isFinite(x)||!Number.isFinite(y)||dx!==null&&(dx!==x||dy!==y))return false;dx=x;dy=y;}
          const target=document.querySelector('.sk-node[data-id="'+id+'"]');if(!target)return false;const rect=target.getBoundingClientRect(),clip=canvas.getBoundingClientRect();
          if(!(rect.width>0&&rect.height>0&&rect.left>=Math.max(0,clip.left)&&rect.right<=Math.min(innerWidth,clip.right)&&rect.top>=Math.max(0,clip.top)&&rect.bottom<=Math.min(innerHeight,clip.bottom)))return false;
          return {generation,gestureId,sequence:Number(canvas.dataset.liveOwnSequence),dx,dy};
        }"""
        return await painted(owner, expression, {**identity,"id":target['id'],"thoughts":[{"id":thought['id'],"version":thought['version'],"x":thought['x'],"y":thought['y']} for thought in selected_thoughts]})
    try:
        return await cohort(fixture, f"map-{count}-drag-{selected}", owner, peer, produce, observe,
                            local_observe, {"resource_id": fixture.map_id, "thoughts": count, "selected": selected,
                                           "selected_bases": [{"id": thought['id'], "version": thought['version'], "x": thought['x'], "y": thought['y']} for thought in selected_thoughts],
                                           "actions": "continuous trusted pointer movement; pointer remains down for local control and all 30+240 samples"})
    finally:
        await owner.mouse.up()


async def main():
    if os.environ.get("FLUX_LIVE_EDITING_TEST") != "1" or not os.environ.get("FLUX_LIVE_SOURCE_SHA") or not os.environ.get("FLUX_LIVE_EVIDENCE"):
        raise SystemExit("Explicit isolated-enabled candidate, source SHA and evidence directory required")
    planned = [f"map-{count}-drag-{selected}" for count, selected in ((50, 1), (50, 50), (500, 1), (500, 50), (500, 200))] + [f"wiki-{units}-{receiver}" for units in (10_000, 100_000) for receiver in ("editor", "reader")]
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    if any((directory/name).exists() or (directory/name).is_symlink() for name in ('planned.json','summary.json',MEASUREMENT_FINISHED_NAME,QUEUE_SEAL_NAME)) or any(directory.glob('*-rows.json')):
        raise RuntimeError('A fresh evidence directory is required; earlier rows cannot certify this run')
    (directory / "planned.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "cases": planned, "samples_per_case": SAMPLES, "warmups_per_case": WARMUPS}, indent=2))
    fixture = LiveFixture()
    fixture.runtime_metadata = runtime_metadata()
    summaries, failures = [], []
    queue = {'status':'INCOMPLETE','reason':'Measurement did not reach actual queue evidence validation'}
    teardown_complete, row_coverage, finished_marker = False, None, None
    try:
        await fixture.asyncSetUp()
        # Each case retains its entire sample set even if its p95 or correctness assertion fails.
        for count, selected in ((50, 1), (50, 50), (500, 1), (500, 50), (500, 200)):
            try:
                summaries.append(await map_drag(fixture, count, selected))
            except Exception as error:
                failures.append({"case": f"map-{count}-drag-{selected}", "error": str(error)})
            fixture.frames = {"ada": [], "kai": []}
        for units in (10_000, 100_000):
            for reader in (False, True):
                try:
                    summaries.append(await wiki(fixture, units, reader))
                except Exception as error:
                    failures.append({"case": f"wiki-{units}-{'reader' if reader else 'editor'}", "error": str(error)})
                fixture.frames = {"ada": [], "kai": []}
                fixture.acks = {"ada": {}, "kai": {}}
    finally:
        try:
            if hasattr(fixture, "browser"):
                await fixture.asyncTearDown()
                teardown_complete = True
        except Exception as error:
            failures.append({"case": "teardown", "error": str(error)})
        try:
            row_coverage = validated_rows(directory,planned,fixture.runtime_metadata['source_sha'])
            if row_coverage['errors'] or row_coverage['completed_case_count'] != len(planned) or row_coverage['scheduled_rows_written'] != len(planned)*SAMPLES:
                failures.append({'case':'scheduled-row-artifacts','error':row_coverage})
            finished_marker = {'schema':1,'measurement_id':str(uuid.uuid4()),'source_sha':fixture.runtime_metadata['source_sha'],
                'driver_sha256':fixture.runtime_metadata['driver_sha256'],'api_instances':fixture.runtime_metadata['server_queue_evidence']['api_instances'],
                'planned_cases':planned,'completed_case_count':row_coverage['completed_case_count'],'scheduled_rows_written':row_coverage['scheduled_rows_written'],
                'teardown_complete':teardown_complete,'finished_at':time.perf_counter()}
            finished_raw = atomic_handoff(directory,MEASUREMENT_FINISHED_NAME,finished_marker)
            # The runner now closes every expected producer, captures each actual final,
            # then stops/flushes its collector and atomically seals immutable raw bytes.
            seal_raw = await await_queue_seal(directory)
            queue = queue_evidence(fixture.runtime_metadata,directory,planned,finished_raw,seal_raw)
        except Exception as error:
            queue = {'status':'INCOMPLETE','reason':str(error)}
        if not teardown_complete and not any(item['case'] == 'teardown' for item in failures):
            failures.append({'case':'teardown','error':'Actual browser teardown did not complete'})
        if queue['status'] != 'COMPLETE':
            failures.append({'case':'actual-server-queue-evidence','error':queue})
        (directory / "summary.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "planned": planned, "summaries": summaries, "failures": failures, "measurement_finished":finished_marker,"row_artifact_validation":row_coverage,"queue_evidence":queue,"runtime_metadata":fixture.runtime_metadata, "unexecuted": [case for case in planned if not (directory / f"{case}-rows.json").exists()]}, indent=2))
    if failures:
        raise SystemExit("Gate 4 FAIL: retained case failures; inspect summary and raw scheduled rows")


if __name__ == "__main__":
    asyncio.run(main())
