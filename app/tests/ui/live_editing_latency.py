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
import time
from pathlib import Path

from test_live_editing import LiveFixture

INTERVAL = .250
DEADLINE = 1.000
SAMPLES = 240
WARMUPS = 30


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
    with Path(path).open('rb') as stream:
        raw = stream.read(65_537)
    if len(raw) > 65_536:
        raise RuntimeError("Runtime metadata exceeds its finite bound")
    value = json.loads(raw)
    required = {"source_sha", "driver_sha256", "collected_at", "hardware", "os", "docker_limits", "db", "dependencies", "network"}
    if not isinstance(value, dict) or set(value) - required - {"server_queue_evidence"} or not required.issubset(value):
        raise RuntimeError("Closed sanitized runtime metadata schema required")
    if value["source_sha"] != os.environ["FLUX_LIVE_SOURCE_SHA"] or not re.fullmatch(r"[a-f0-9]{40}", value["source_sha"]):
        raise RuntimeError("Runtime metadata does not match the exact candidate SHA")
    if value['driver_sha256'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise RuntimeError('The Docker image contains a different latency driver than the frozen candidate')
    schemas = {"hardware": {"cpu", "logical_cores", "memory_bytes"}, "os": {"host", "container"},
               "db": {"image", "version"}, "network": {"condition", "setup"}}
    for key, fields in schemas.items():
        if not isinstance(value[key], dict) or set(value[key]) != fields or any(item is None or item == "" for item in value[key].values()):
            raise RuntimeError(f"Actual sanitized {key} observations are required")
    if not value["docker_limits"] or not isinstance(value["docker_limits"], dict):
        raise RuntimeError("Actual Docker service limits are required")
    for item in value["docker_limits"].values():
        if not isinstance(item, dict) or set(item) != {"image", "cpus", "memory_bytes", "pids_limit"}:
            raise RuntimeError("Docker metadata may contain only image and explicit resource limits")
    dependencies = value["dependencies"]
    if not isinstance(dependencies, dict) or not dependencies or not re.fullmatch(r"[a-f0-9]{64}", str(dependencies.get("pnpm_lock_sha256", ""))):
        raise RuntimeError("Exact dependency versions and lockfile hash are required")
    if any(not isinstance(item, (str, int, float, bool)) for item in dependencies.values()):
        raise RuntimeError("Dependency metadata contains non-version fields")
    if not {"yjs", "@codemirror/state", "@codemirror/view", "y-codemirror.next", "ws", "pnpm_lock_sha256"}.issubset(dependencies):
        raise RuntimeError("Exact collaboration/transport dependency pins are required")
    evidence = value.get('server_queue_evidence')
    if evidence is not None and (not isinstance(evidence, dict) or set(evidence) != {'path','format','source_sha','meaning','complete'} or evidence['format'] != 'jsonl' or evidence['source_sha'] != value['source_sha'] or not isinstance(evidence['complete'], bool)):
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


def queue_evidence(metadata, directory, planned):
    descriptor = metadata.get('server_queue_evidence')
    if not descriptor:
        return {'status':'INCOMPLETE','reason':'Actual server queue-depth evidence was not supplied'}
    directory = directory.resolve()
    path = Path(descriptor['path']).resolve()
    if path == directory or directory not in path.parents or not path.is_file():
        return {'status':'INCOMPLETE','reason':'Queue evidence must be an existing raw file inside the mounted evidence directory'}
    with path.open('rb') as stream:
        raw = stream.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024 or not raw.endswith(b'\n'):
        return {'status':'INCOMPLETE','reason':'Queue evidence exceeds the finite runner bound or has a truncated final record'}
    counters = {'admissionQueued','codecWaiting','codecActive','mapQueued','mapActive','externalInputBytes','externalOutputBytes',
                'peakAdmissionQueued','peakCodecWaiting','peakMapQueued','droppedRecords'}
    allowed = counters | {'schema','apiInstance','kind','resourceId','generation','commandId','interactionId','inputSequence','confirmedSequence','backpressured'}
    records, peaks, instances = [], {}, set()
    incomplete = not descriptor['complete']
    for line in raw.splitlines():
        record = json.loads(line)
        if not isinstance(record, dict) or set(record) - allowed or type(record.get('schema')) is not int or record['schema'] != 1 or not isinstance(record.get('apiInstance'), str) or not record['apiInstance']:
            return {'status':'INCOMPLETE','reason':'Unknown or non-primitive telemetry record schema'}
        if not {'kind','resourceId','generation','droppedRecords'}.issubset(record) or any(not isinstance(record.get(key), int) or isinstance(record[key], bool) or record[key] < 0 for key in counters if key in record):
            return {'status':'INCOMPLETE','reason':'Actual counters or cumulative drop count are missing/invalid'}
        if any(not isinstance(value, (str, int, bool, type(None))) for value in record.values()):
            return {'status':'INCOMPLETE','reason':'Telemetry contains non-primitive values'}
        incomplete |= record['droppedRecords'] > 0 or record.get('backpressured', False)
        for key in counters:
            if key in record:
                peaks[key] = max(peaks.get(key, record[key]), record[key])
        if record.get('externalInputBytes',0) > 32*1024*1024 or record.get('externalOutputBytes',0) > 32*1024*1024:
            incomplete = True
        instances.add(record['apiInstance']); records.append(record)
    if not records or not {'admissionQueued','codecWaiting','codecActive','mapQueued','mapActive'}.issubset(peaks):
        incomplete = True
    correlations = {}
    for case in planned:
        rows_path = directory / f'{case}-rows.json'
        if not rows_path.is_file():
            continue
        rows = json.loads(rows_path.read_text())
        matched = 0
        for row in rows:
            identity, coverage = row.get('identity',{}), row.get('coverage',{})
            matches = [record for record in records if record.get('resourceId') == row.get('resource_id') and record.get('generation') == identity.get('generation') and (
                identity.get('commandId') is not None and record.get('commandId') == identity['commandId'] or
                identity.get('gestureId') is not None and record.get('interactionId') == identity['gestureId'] and record.get('inputSequence') == coverage.get('publication_sequence'))]
            if matches:
                row['queue_depth'] = {**row.get('queue_depth',{}), 'server':matches[-1], 'meaning':'Actual correlated admission snapshot, separate from DOM latency clock'}
                matched += 1
        rows_path.write_text(json.dumps(rows,indent=2))
        correlations[case] = {'scheduled_rows':len(rows),'correlated_rows':matched,'unavailable_rows':len(rows)-matched}
    # Per-row depth is optional in the contract; actual aggregate depth/peaks remain
    # mandatory. Null stays null where no correlation exists. No zero is invented.
    return {'status':'INCOMPLETE' if incomplete else 'COMPLETE','raw_path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),
            'record_count':len(records),'api_instances':sorted(instances),'observed_peaks':peaks,'correlations':correlations,
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
    if (directory/'planned.json').exists() or (directory/'summary.json').exists() or any(directory.glob('*-rows.json')):
        raise RuntimeError('A fresh evidence directory is required; earlier rows cannot certify this run')
    (directory / "planned.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "cases": planned, "samples_per_case": SAMPLES, "warmups_per_case": WARMUPS}, indent=2))
    fixture = LiveFixture()
    fixture.runtime_metadata = runtime_metadata()
    summaries, failures = [], []
    queue = {'status':'INCOMPLETE','reason':'Measurement did not reach actual queue evidence validation'}
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
        except Exception as error:
            failures.append({"case": "teardown", "error": str(error)})
        try:
            queue = queue_evidence(fixture.runtime_metadata,directory,planned)
        except Exception as error:
            queue = {'status':'INCOMPLETE','reason':str(error)}
        if queue['status'] != 'COMPLETE':
            failures.append({'case':'actual-server-queue-evidence','error':queue})
        (directory / "summary.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "planned": planned, "summaries": summaries, "failures": failures, "queue_evidence":queue,"runtime_metadata":fixture.runtime_metadata, "unexecuted": [case for case in planned if not (directory / f"{case}-rows.json").exists()]}, indent=2))
    if failures:
        raise SystemExit("Gate 4 FAIL: retained case failures; inspect summary and raw scheduled rows")


if __name__ == "__main__":
    asyncio.run(main())
