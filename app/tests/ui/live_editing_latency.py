"""#228 fixed-denominator, continuous real-input two-user visible-paint driver.

Run in Docker against the isolated enabled candidate:
FLUX_LIVE_EDITING_TEST=1 FLUX_LIVE_SOURCE_SHA=<frozen SHA> \
FLUX_LIVE_EVIDENCE=/evidence python tests/ui/live_editing_latency.py

Each case has 30 warm-ups and 240 scheduled samples spaced 250ms, over 60 seconds.
Inputs continue between samples. Deadline is 1000ms including two requestAnimationFrames.
Every failure/timeout stays in the denominator with infinite latency. No overhead subtraction.
Wiki samples require the exact original UUID's real server ACK and a peer applied/rendered
sequence that covers that receipt, rather than a text-only marker. Map samples require the
same generation and gesture with a preview sequence covering that trusted pointer input.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
from pathlib import Path

from test_live_editing import LiveFixture

INTERVAL = .250
DEADLINE = 1.000
SAMPLES = 240
WARMUPS = 30


async def painted(page, expression, arg):
    await page.wait_for_function(expression, arg=arg, timeout=DEADLINE * 1000)
    await page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


async def cohort(fixture, case, owner, peer, producer, observer, metadata):
    fixture.assertEqual(await owner.evaluate("document.visibilityState"), "visible")
    fixture.assertEqual(await peer.evaluate("document.visibilityState"), "visible")
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    await owner.context.tracing.start(screenshots=True, snapshots=True, sources=False)
    await peer.context.tracing.start(screenshots=True, snapshots=True, sources=False)
    stop = asyncio.Event()
    latest = {}
    errors = []
    async def inputs():
        while not stop.is_set():
            started = time.perf_counter()  # Before trusted keyboard/pointer dispatch.
            try:
                identity = await producer()
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
                    await asyncio.wait_for(observer(dict(latest["identity"])), DEADLINE)
                except Exception:
                    pass  # Warm-ups are excluded by a fixed, predeclared count only.
        schedule = time.perf_counter()
        rows = [None] * SAMPLES
        observations = []
        previous_input = None
        async def sample(index, scheduled, target, fresh):
            row = {"case": case, "index": index, "scheduled_at": scheduled, "observed_at": time.perf_counter(), "deadline_ms": 1000, **(target or {})}
            if not target or not fresh:
                row.update(outcome="error", error="No fresh continuous trusted input identity", latency_ms=None)
            else:
                row["identity"] = dict(target["identity"])
                remaining = min(DEADLINE - (time.perf_counter() - target["input_at"]), scheduled + DEADLINE - time.perf_counter())
                try:
                    if remaining <= 0:
                        raise asyncio.TimeoutError("Input/scheduled observation already exceeded fixed deadline")
                    await asyncio.wait_for(observer(row["identity"]), remaining)
                    row.update(outcome="painted", latency_ms=(time.perf_counter() - target["input_at"]) * 1000)
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
    socket_errors = [row for key in ("ada", "kai") for row in fixture.frames[key]
        if row["header"].get("type") in ("error", "resync", "revoked")]
    latencies = sorted(row["latency_ms"] if row["latency_ms"] is not None else math.inf for row in rows)
    p95 = latencies[math.ceil(.95 * SAMPLES) - 1]
    summary = {"case": case, "source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "samples": len(rows), "warmups": WARMUPS,
        "interval_ms": 250, "duration_s": 60, "timeout_ms": 1000, "p95_ms": p95 if math.isfinite(p95) else None,
        "failures": sum(row["outcome"] != "painted" for row in rows), "input_errors": errors, "socket_errors": socket_errors,
        "fixture": metadata, "viewport": {"width": 1440, "height": 900}, "browser": owner.context.browser.version,
        "environment": {"origin": "same-origin isolated Docker fixture", "headless": True, "reduced_motion": True,
                        "clock": "one Python monotonic driver; browser round trips and two RAF included; no subtraction"}}
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{case}-rows.json").write_text(json.dumps(rows, indent=2))
    (directory / f"{case}-summary.json").write_text(json.dumps(summary, indent=2))
    await peer.screenshot(path=str(directory / f"{case}-peer.png"), full_page=True)
    fixture.assertEqual(len(rows), 240)
    fixture.assertEqual(summary["failures"], 0, summary)
    fixture.assertEqual(errors, [], summary)
    fixture.assertEqual(socket_errors, [], summary)
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
        identity = await owner.locator('[data-live-wiki-editor]').evaluate("el => ({inputRevision:Number(el.dataset.liveInputRevision),generation:el.dataset.liveGeneration})")
        if not identity.get("inputRevision"):
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
        await painted(peer, "({selector,generation,sequence,body}) => { const el=document.querySelector(selector), content=document.querySelector(body); if (!el || !content || el.dataset.liveGeneration!==generation || Number(el.dataset.liveSequence)<sequence) return false; const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT); let last=null,node; while ((node=walker.nextNode())) if (node.length && !node.parentElement.closest('.editing-caret')) last=node; if (!last) return false; const range=document.createRange(); range.setStart(last,last.length-1); range.setEnd(last,last.length); const rect=range.getBoundingClientRect(); return rect.width>0 && rect.height>0 && rect.top>=0 && rect.bottom<=innerHeight && rect.left>=0 && rect.right<=innerWidth; }", {"selector": selector, "body": '.doc-prose' if reader else '.cm-content', "generation": identity["generation"], "sequence": receipt["sequence"]})
    return await cohort(fixture, f"wiki-{units}-{'reader' if reader else 'editor'}", owner, peer, produce, observe,
                        {"body_units": units, "actions": "continuous native keyboard replace-one-character; length constant; changed final character stays in both viewports", "receiver": "ordinary reader sanitized HTML" if reader else "CodeMirror Yjs editor"})


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
        identity = await owner.locator('.sk-canvas').evaluate("el => ({gestureId:el.dataset.liveOwnGesture,generation:el.dataset.liveGeneration,sequence:Number(el.dataset.liveOwnSequence)})")
        if not identity.get("gestureId") or identity["sequence"] < 1:
            raise RuntimeError("Trusted drag has no current authorized gesture/input sequence")
        return identity
    async def observe(identity):
        expression = "({id,thoughts,gestureId,generation,sequence}) => { let dx=null,dy=null,lease=null,preview=null; for (const base of thoughts) { const el=document.querySelector('.sk-node[data-id=\"'+base.id+'\"]'); if (!el || el.dataset.liveGeneration!==generation || el.dataset.liveGesture!==gestureId || Number(el.dataset.livePreviewSequence)<sequence || Number(el.dataset.thoughtVersion)!==base.version) return false; const current=Number(el.dataset.livePreviewSequence), x=Number(el.dataset.thoughtX)-base.x, y=Number(el.dataset.thoughtY)-base.y; if (!Number.isFinite(x) || !Number.isFinite(y) || !el.dataset.liveLease) return false; if (dx!==null && (dx!==x || dy!==y || lease!==el.dataset.liveLease || preview!==current)) return false; dx=x; dy=y; lease=el.dataset.liveLease; preview=current; } const target=document.querySelector('.sk-node[data-id=\"'+id+'\"]'), canvas=document.querySelector('.sk-canvas'); if (!target || !canvas) return false; const box=target.getBoundingClientRect(), clip=canvas.getBoundingClientRect(); return box.width>0 && box.height>0 && box.left>=Math.max(0,clip.left) && box.right<=Math.min(innerWidth,clip.right) && box.top>=Math.max(0,clip.top) && box.bottom<=Math.min(innerHeight,clip.bottom); }"
        observed = {"id": target["id"], "thoughts": [{"id": thought["id"], "version": thought["version"], "x": thought["x"], "y": thought["y"]} for thought in selected_thoughts], **identity}
        await painted(peer, expression, observed)
        # Validate the same entire group once more after the two RAFs. A token on
        # only the target or a group truncated to one thought is never a success.
        if not await peer.evaluate(expression, observed):
            raise RuntimeError('Selected group lost coherent authorized preview/viewport through two RAFs')
    try:
        return await cohort(fixture, f"map-{count}-drag-{selected}", owner, peer, produce, observe,
                            {"thoughts": count, "selected": selected, "actions": "continuous trusted pointer movement; pointer remains down for all 30+240 samples"})
    finally:
        await owner.mouse.up()


async def main():
    if os.environ.get("FLUX_LIVE_EDITING_TEST") != "1" or not os.environ.get("FLUX_LIVE_SOURCE_SHA") or not os.environ.get("FLUX_LIVE_EVIDENCE"):
        raise SystemExit("Explicit isolated-enabled candidate, source SHA and evidence directory required")
    planned = [f"map-{count}-drag-{selected}" for count, selected in ((50, 1), (50, 50), (500, 1), (500, 50), (500, 200))] + [f"wiki-{units}-{receiver}" for units in (10_000, 100_000) for receiver in ("editor", "reader")]
    directory = Path(os.environ["FLUX_LIVE_EVIDENCE"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "planned.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "cases": planned, "samples_per_case": SAMPLES, "warmups_per_case": WARMUPS}, indent=2))
    fixture = LiveFixture()
    summaries, failures = [], []
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
        (directory / "summary.json").write_text(json.dumps({"source_sha": os.environ["FLUX_LIVE_SOURCE_SHA"], "planned": planned, "summaries": summaries, "failures": failures, "unexecuted": [case for case in planned if not (directory / f"{case}-rows.json").exists()]}, indent=2))
    if failures:
        raise SystemExit("Gate 4 FAIL: retained case failures; inspect summary and raw scheduled rows")


if __name__ == "__main__":
    asyncio.run(main())
