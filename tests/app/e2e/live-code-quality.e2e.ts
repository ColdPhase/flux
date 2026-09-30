import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { readReceiverSample } from '../../../apps/web/src/live/receiver-quality.js';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';
import { mediaPage } from '../support/live-sfu.js';
import { connect, markResourcePhase, receiverReports, selectedCandidates } from '../support/live-turn.js';
import { drawCodeSource } from '../support/live-code-source.js';

type CodeWindow = Window & {
  drawCodeSource: typeof drawCodeSource;
  fluxRoom: { localParticipant: { publishTrack(track: MediaStreamTrack,
    options: Record<string, unknown>): Promise<unknown> }; disconnect(): Promise<void>; remoteParticipants: Map<string, {
      videoTrackPublications: Map<string, { trackName: string; isSubscribed: boolean;
        track?: { attach(): HTMLVideoElement } }> }> };
  sourceTimes: Record<number, number>; sourceFrame: number;
  screenPending?: Promise<MediaStream>; sourceTrack: MediaStreamTrack;
  frameEvents: Record<string, Array<{ frame: number; receivedUtcMs: number;
    presentedFrames: number; width: number; height: number; processingDuration?: number }>>;
};

async function rawStats(page: Page) {
  return page.evaluate(async () => {
    const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
    return (await Promise.all(pcs.map(async (pc, index) => [...(await pc.getStats()).values()]
      .filter((s) => ['outbound-rtp', 'inbound-rtp', 'remote-inbound-rtp', 'codec',
        'transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type))
      .map((s) => ({ ...s, id: `${index}:${s.id}` }))))).flat();
  });
}

async function source(page: Page, share: number, display: boolean) {
  await page.addScriptTag({ content: `window.drawCodeSource = ${drawCodeSource.toString()}` });
  await page.evaluate(({ share, display }) => {
    const w = window as unknown as CodeWindow;
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#101827';
    document.body.replaceChildren();
    const canvas = document.createElement('canvas');
    canvas.width = 2560; canvas.height = 1440;
    canvas.id = 'code-source';
    document.body.append(canvas);
    w.sourceFrame = 0; w.sourceTimes = {};
    const draw = () => {
      w.drawCodeSource(canvas, ++w.sourceFrame, share);
      w.sourceTimes[w.sourceFrame] = Date.now();
    };
    draw(); window.setInterval(draw, 1000 / 15);
    if (display) {
      const button = document.createElement('button');
      button.id = 'share'; button.textContent = 'Share isolated code display';
      button.style.cssText = 'position:fixed;top:40px;left:8px';
      button.onclick = () => {
        w.screenPending = navigator.mediaDevices.getDisplayMedia({ audio: false,
          video: { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 15, max: 15 } } });
        button.remove();
      };
      document.body.append(button);
    } else w.screenPending = Promise.resolve(canvas.captureStream(15));
  }, { share, display });
  if (display) await page.click('#share');
  return page.evaluate(async ({ share, display }) => {
    const w = window as unknown as CodeWindow;
    const stream = await w.screenPending;
    const track = stream?.getVideoTracks()[0];
    if (!track) throw new Error('Actual source track missing');
    w.sourceTrack = track;
    track.contentHint = 'detail';
    await w.fluxRoom.localParticipant.publishTrack(track, { name: `code-${share}`,
      source: 'screen_share', videoCodec: 'vp8', simulcast: false,
      screenShareEncoding: { maxBitrate: 3_500_000, maxFramerate: 15 },
      degradationPreference: 'maintain-resolution' });
    return { sourceKind: display ? 'getDisplayMedia/Xvfb' : 'canvas.captureStream',
      share, settings: track.getSettings(), contentHint: track.contentHint, readyState: track.readyState };
  }, { share, display });
}

async function attach(page: Page, expected: number) {
  await page.waitForFunction((count) => {
    const room = (window as unknown as CodeWindow).fluxRoom;
    return [...room.remoteParticipants.values()].flatMap((p) => [...p.videoTrackPublications.values()])
      .filter((p) => p.track && p.isSubscribed).length >= count;
  }, expected, { timeout: 30_000 });
  await page.addScriptTag({ content: `window.drawCodeSource = ${drawCodeSource.toString()}` });
  await page.evaluate(() => {
    const w = window as unknown as CodeWindow;
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:0;background:#101827;color:white;font:16px monospace';
    w.frameEvents = {};
    for (const p of w.fluxRoom.remoteParticipants.values()) for (const pub of p.videoTrackPublications.values()) {
      if (!pub.track) continue;
      const video = pub.track.attach();
      video.dataset.share = pub.trackName;
      video.style.cssText = 'display:block;width:2560px;height:1440px;object-fit:contain';
      document.body.append(video);
      const marker = document.createElement('canvas'); marker.width = 464; marker.height = 32;
      const g = marker.getContext('2d')!;
      const events: CodeWindow['frameEvents'][string] = []; w.frameEvents[pub.trackName] = events;
      const read = (_now: number, info: VideoFrameCallbackMetadata) => {
        if (video.videoWidth) {
          g.drawImage(video, 0, 0, 464 * video.videoWidth / 2560, 32 * video.videoHeight / 1440, 0, 0, 464, 32);
          const pixels = g.getImageData(0, 0, 464, 32).data;
          const bit = (i: number) => pixels[(20 * 464 + 16 + i * 16) * 4]! > 128;
          if (bit(0) && !bit(1) && bit(2) && !bit(3)) {
            let frame = 0;
            for (let i = 0; i < 24; i++) if (bit(i + 4)) frame += 2 ** i;
            events.push({ frame, receivedUtcMs: Date.now(), presentedFrames: info.presentedFrames,
              width: info.width, height: info.height, processingDuration: info.processingDuration });
          }
        }
        video.requestVideoFrameCallback(read);
      };
      video.requestVideoFrameCallback(read);
    }
  });
  await page.waitForFunction((count) => {
    const w = window as unknown as CodeWindow;
    return Object.values(w.frameEvents).filter((events) => events.length >= 3).length >= count;
  }, expected, { timeout: 30_000 });
}

async function decodedImage(page: Page, name: string, label: string) {
  const image = await page.evaluate((name) => {
    const w = window as unknown as CodeWindow;
    const video = [...document.querySelectorAll('video')].find((v) => v.dataset.share === name)!;
    const decoded = document.createElement('canvas');
    decoded.width = video.videoWidth; decoded.height = video.videoHeight;
    const g = decoded.getContext('2d')!; g.drawImage(video, 0, 0);
    const scaleX = decoded.width / 2560, scaleY = decoded.height / 1440;
    const bit = (i: number) => g.getImageData(Math.round((16 + i * 16) * scaleX),
      Math.round(20 * scaleY), 1, 1).data[0]! > 128;
    if (!(bit(0) && !bit(1) && bit(2) && !bit(3))) throw new Error('Decoded image marker sync invalid');
    let frame = 0;
    for (let i = 0; i < 24; i++) if (bit(i + 4)) frame += 2 ** i;
    const original = document.createElement('canvas'); original.width = 2560; original.height = 1440;
    w.drawCodeSource(original, frame, Number(name.split('-')[1]));
    const crops = [{ x: 64, y: 110, width: 1000, height: 220, textPx: 14 },
      { x: 1344, y: 110, width: 1000, height: 220, textPx: 16 }].map((rect) => {
      const crop = document.createElement('canvas'); crop.width = rect.width; crop.height = rect.height;
      const cg = crop.getContext('2d')!;
      cg.drawImage(decoded, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX,
        rect.height * scaleY, 0, 0, rect.width, rect.height);
      const reference = original.getContext('2d')!.getImageData(rect.x, rect.y, rect.width, rect.height).data;
      const actual = cg.getImageData(0, 0, rect.width, rect.height).data;
      let squared = 0;
      for (let i = 0; i < actual.length; i++) if (i % 4 !== 3) squared += (actual[i]! - reference[i]!) ** 2;
      const mse = squared / (rect.width * rect.height * 3);
      return { ...rect, psnrDb: mse > 0 ? 10 * Math.log10(255 ** 2 / mse) : null, png: crop.toDataURL() };
    });
    return { width: decoded.width, height: decoded.height, frame,
      decoded: decoded.toDataURL(), original: original.toDataURL(), crops };
  }, name);
  const png = (suffix: string, data: string) => writeFileSync(`/artifacts/${label}-${name}-${suffix}.png`,
    Buffer.from(data.split(',')[1]!, 'base64'));
  png('decoded-natural', image.decoded); png('source-natural', image.original);
  for (const crop of image.crops) png(`text-${crop.textPx}px`, crop.png);
  return { ...image, decoded: undefined, original: undefined,
    crops: image.crops.map(({ x, y, width, height, textPx, psnrDb }) => ({ x, y, width, height, textPx, psnrDb })) };
}

test('code-1440p: two then four authorized peers receive scrolling 14/16px text over TURN/TLS',
  { timeout: 180_000 }, async () => {
    const people = await Promise.all(['publisher', 'viewer', 'second', 'observer'].map((role) => person(`code-${role}`)));
    const owner = people[0]!;
    const ws = await workspace(owner, 'Code calibration');
    for (const member of people.slice(1)) await addMember(owner, ws.id, member, 'member');
    const place = await project(owner, ws.id, '1440p code', 'restricted');
    for (const member of people.slice(1)) await grant(owner, place.id, member, 'contributor');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Code quality calibration', clientMessageId: randomUUID() } }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions',
      { body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() } }), 201) as LiveSession;
    const headless = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const display = await chromium.launch({ headless: false, args: ['--no-sandbox', '--start-fullscreen',
      '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'] });
    const report: Record<string, unknown> = { profile: 'code-1440p', productionPublishDefaults: true, calibrationIcePolicy: 'relay-only', productUiIcePolicy: 'automatic/unmodified',
      physicalDevicesUsed: false, startedUtc: new Date().toISOString() };
    try {
      const pages: Page[] = [];
      const join = async (index: number) => {
        const member = people[index]!;
        const media = expectStatus(await member.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
        const page = await mediaPage(index === 0 ? display : headless, member.browser, { viewport: index === 0 ? null : { width: 1280, height: 800 } });
        await connect(page, media, undefined, true); pages[index] = page;
        return page;
      };
      await join(0); await join(1);
      const cdp = await pages[0]!.context().newCDPSession(pages[0]!);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 2560, height: 1440 } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
      await pages[0]!.setViewportSize({ width: 2560, height: 1440 });
      const sourceRequestedUtcMs = Date.now();
      const sources = [await source(pages[0]!, 1, true)]; report.sources = sources;
      await pages[0]!.evaluate(async () => {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(), output = context.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(output); oscillator.start();
        await (window as unknown as CodeWindow).fluxRoom.localParticipant.publishTrack(output.stream.getAudioTracks()[0]!,
          { name: 'generated-tone-not-speech', source: 'microphone' });
      });
      assert.equal(sources[0]!.readyState, 'live');
      await pages[0]!.screenshot({ path: '/artifacts/code-source-display.png' });
      const publishedAt = Date.now();
      await attach(pages[1]!, 1);
      report.attachToAuditableFramesMs = Date.now() - publishedAt;
      report.sourceRequestedUtcMs = sourceRequestedUtcMs;
      report.firstAuditableFrameMs = await pages[1]!.evaluate((start) =>
        (window as unknown as CodeWindow).frameEvents['code-1']![0]!.receivedUtcMs - start, sourceRequestedUtcMs);
      const stages: unknown[] = []; report.stages = stages;
      for (const peers of [2, 4]) {
        if (peers === 4) {
          await join(2); await join(3);
          sources.push(await source(pages[2]!, 2, false));
          await attach(pages[1]!, 2); await attach(pages[3]!, 2);
        }
        for (const page of pages) await page.waitForFunction((count) =>
          (window as unknown as CodeWindow).fluxRoom.remoteParticipants.size === count - 1, peers, { timeout: 15_000 });
        const phase = `code_${peers}`; markResourcePhase(`${phase}_active`);
        const before = await Promise.all(pages.map(receiverReports));
        const start = Date.now();
        const raw: unknown[] = [];
        for (let i = 0; i < 6; i++) {
          await delay(2_000);
          const entry = { timestampUtc: new Date().toISOString(), peers,
            clients: await Promise.all(pages.map(rawStats)) };
          raw.push(entry); appendFileSync('/artifacts/code-1440p-stats.jsonl', `${JSON.stringify(entry)}\n`);
        }
        const elapsedMs = Date.now() - start;
        const after = await Promise.all(pages.map(receiverReports));
        const candidates = await Promise.all(pages.map(selectedCandidates));
        for (const set of candidates) {
          assert.ok(set.length > 0);
          for (const pair of set) { assert.equal(pair.candidateType, 'relay'); assert.equal(pair.relayProtocol, 'tls'); }
        }
        const images: unknown[] = [];
        for (const index of peers === 2 ? [1] : [1, 3]) {
          const page = pages[index]!;
          const sample = readReceiverSample(after[index]!, before[index]!, elapsedMs);
          assert.equal(sample.tracks.filter((t) => t.kind === 'video' && (t.framesDelta ?? 0) > 0).length,
            peers === 2 ? 1 : 2, 'each screen needs fresh actual decoded frames');
          for (const name of peers === 2 ? ['code-1'] : ['code-1', 'code-2']) {
            const image = await decodedImage(page, name, `${phase}-viewer-${index + 1}`);
            images.push({ viewer: index + 1, name, ...image });
          }
          // Explicit harness render modes. These do not certify #62's product UI.
          await page.locator('video').evaluateAll((videos) => videos.forEach((v) => { (v as HTMLElement).style.width = '1280px'; (v as HTMLElement).style.height = '720px'; }));
          await page.screenshot({ path: `/artifacts/${phase}-viewer-${index + 1}-fit.png`, fullPage: true });
          await page.locator('video').evaluateAll((videos) => videos.forEach((v) => { (v as HTMLElement).style.width = '2560px'; (v as HTMLElement).style.height = '1440px'; }));
          await page.screenshot({ path: `/artifacts/${phase}-viewer-${index + 1}-one-to-one.png`, fullPage: true });
          await page.locator('video').evaluateAll((videos) => videos.forEach((v) => { (v as HTMLElement).style.width = '5120px'; (v as HTMLElement).style.height = '2880px'; }));
          await page.screenshot({ path: `/artifacts/${phase}-viewer-${index + 1}-zoom-two.png` });
          await page.locator('video').evaluateAll((videos) => videos.forEach((v) => { (v as HTMLElement).style.width = '2560px'; (v as HTMLElement).style.height = '1440px'; }));
        }
        const events = await Promise.all(pages.map((page) => page.evaluate(() => (window as unknown as CodeWindow).frameEvents ?? {})));
        const sourceTimes = await Promise.all([pages[0]!, ...(peers === 4 ? [pages[2]!] : [])]
          .map((page) => page.evaluate(() => (window as unknown as CodeWindow).sourceTimes)));
        stages.push({ peers, elapsedMs, windowStartUtcMs: start, windowEndUtcMs: start + elapsedMs, before, after, receiverSamples: after.map((stats, i) =>
          readReceiverSample(stats, before[i]!, elapsedMs)), candidates, images, events, sourceTimes, rawSamples: raw.length });
        markResourcePhase(`${phase}_verified`);
        writeFileSync('/artifacts/code-1440p-report.json', JSON.stringify(report, null, 2));
        for (const image of images as Array<{ width: number; height: number }>) {
          assert.equal(image.width, 2560, '1440p target downscaled: retained actual image/report');
          assert.equal(image.height, 1440, '1440p target downscaled: retained actual image/report');
        }
      }
      // Rejoin one observer through the actual Flux app, keeping the same four
      // people/cookies. Exercise the existing selected-screen and diagnostic
      // path rather than calling the new formatter directly from this harness.
      const app = pages[1]!;
      await app.evaluate(() => (window as unknown as CodeWindow).fluxRoom.disconnect());
      await app.addInitScript(() => {
        const pcs: RTCPeerConnection[] = [];
        (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs = pcs;
        const original = window.RTCPeerConnection;
        window.RTCPeerConnection = new Proxy(original, { construct(target, args) {
          const pc = Reflect.construct(target, args) as RTCPeerConnection;
          pcs.push(pc); return pc;
        } });
      });
      await app.goto(new URL(`/projects/${place.id}/conversations/${conversation.id}`, app.url()).href);
      await app.locator('header.top').getByRole('button', { name: 'Join', exact: true }).click();
      const bar = app.getByRole('region', { name: 'Live session', exact: true });
      await app.waitForFunction(() => document.querySelectorAll('.lv-bar .lv-face').length === 4, undefined, { timeout: 15_000 });
      await bar.getByRole('button', { name: '2 screens', exact: true }).click();
      const stage = app.getByRole('region', { name: 'Shared screens and cameras' });
      assert.equal(await stage.getByRole('radio').count(), 2);
      await stage.getByRole('radio').first().click();
      await app.waitForFunction(() => {
        const v = document.querySelector<HTMLVideoElement>('.lv-stage__video');
        return v?.videoWidth === 2560 && v.videoHeight === 1440;
      }, undefined, { timeout: 30_000 });
      await stage.getByRole('button', { name: '1:1', exact: true }).click();
      const actualSize = await stage.locator('video').evaluate((v: HTMLVideoElement) => ({
        naturalWidth: v.videoWidth, renderedWidth: v.getBoundingClientRect().width,
        naturalHeight: v.videoHeight, renderedHeight: v.getBoundingClientRect().height, ratio: devicePixelRatio }));
      assert.equal(actualSize.renderedWidth * actualSize.ratio, actualSize.naturalWidth);
      await app.screenshot({ path: '/artifacts/code-product-one-to-one.png' });
      for (let i = 0; i < 3; i++) await stage.getByRole('button', { name: 'Zoom in', exact: true }).click();
      assert.equal(await stage.locator('.lv-stage__pct').textContent(), '200%');
      await app.screenshot({ path: '/artifacts/code-product-zoom-two.png' });
      // The existing stage stacks above the LivePanel popover. Return through
      // its real control before opening details; preserve the observed overlap
      // as a separate UI limitation, rather than using a forced pointer click.
      await stage.getByRole('button', { name: 'Back to work', exact: true }).click();
      await bar.getByRole('button', { name: 'Session details and more', exact: true }).click();
      const panel = app.getByRole('dialog', { name: 'Live session', exact: true });
      await panel.getByRole('button', { name: 'Connection details', exact: true }).click();
      const table = panel.getByRole('table', { name: 'Measured connection details' });
      await table.waitFor();
      await app.waitForFunction(() => [...document.querySelectorAll('.lv-diag__row')].some((row) =>
        row.textContent?.includes('Screen') && /\d+\.\d+ fps/.test(row.textContent)), undefined, { timeout: 15_000 });
      await app.waitForFunction(() => [...document.querySelectorAll('.lv-diag__row')].some((row) =>
        row.querySelector('.lv-diag__what')?.textContent === 'Voice' &&
        /\d+\.\d+ % lost/.test(row.querySelector('.lv-diag__v')?.textContent ?? '') &&
        !row.querySelector('.lv-diag__warn')), undefined, { timeout: 15_000 });
      const rows = await table.getByRole('row').allTextContents();
      assert.ok(rows.some((row) => row.includes('2560×1440') && /\d+\.\d+ fps/.test(row)));
      assert.ok(rows.every((row) => !/-\d+(?:\.\d+)? (fps|kbit\/s)/.test(row)));
      report.productDiagnosticPath = { actualSize, detailsOpenedAfterBackToWork: true,
        screenMayBeIntentionallyPausedWhenHidden: true, rows, rawStats: await rawStats(app),
        candidates: await selectedCandidates(app) };
      await app.screenshot({ path: '/artifacts/code-product-diagnostics.png' });
      await app.keyboard.press('Escape');
      await bar.getByRole('button', { name: 'Leave', exact: true }).click();
      report.browserVersion = headless.version(); report.finishedUtc = new Date().toISOString();
    } catch (error) {
      report.failure = String(error);
      for (const [index, context] of [...display.contexts(), ...headless.contexts()].entries()) {
        for (const page of context.pages()) {
          report[`failureClient${index}`] = { stats: await rawStats(page).catch(() => []),
            events: await page.evaluate(() => (window as unknown as CodeWindow).frameEvents ?? {}).catch(() => ({})),
            geometry: await page.evaluate(() => ({ innerWidth, innerHeight, screenWidth: screen.width,
              screenHeight: screen.height, dpr: devicePixelRatio })).catch(() => ({})) };
          await page.screenshot({ path: `/artifacts/failure-client-${index}.png` }).catch(() => undefined);
          const frames = await page.locator('video').evaluateAll((videos) => videos.filter((v) =>
            (v as HTMLVideoElement).videoWidth > 0).map((v) => {
              const video = v as HTMLVideoElement, canvas = document.createElement('canvas');
              canvas.width = video.videoWidth; canvas.height = video.videoHeight;
              canvas.getContext('2d')!.drawImage(video, 0, 0);
              return canvas.toDataURL();
            })).catch(() => []);
          for (const [number, png] of frames.entries()) writeFileSync(`/artifacts/failure-client-${index}-decoded-${number}.png`, Buffer.from(png.split(',')[1]!, 'base64'));
        }
      }
      throw error;
    } finally {
      writeFileSync('/artifacts/code-1440p-report.json', JSON.stringify(report, null, 2));
      await Promise.all([display.close(), headless.close()]);
    }
  });
