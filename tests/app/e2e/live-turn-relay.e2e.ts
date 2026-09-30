import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { assessReceiverQuality, readReceiverSample, RECEIVER_QUALITY_LIMITS } from '../../../apps/web/src/live/receiver-quality.js';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';
import { mediaPage } from '../support/live-sfu.js';
import { connect, markResourcePhase, receiverReports, selectedCandidates } from '../support/live-turn.js';

let browser: Browser | undefined;
after(async () => browser?.close());

test('two authorized Chromium clients exchange media when UDP and direct ICE/TCP are blocked',
  { timeout: 180_000 }, async () => {
    const owner = await person('relay-owner');
    const member = await person('relay-member');
    const ws = await workspace(owner, 'Relay proof');
    await addMember(owner, ws.id, member, 'member');
    const place = await project(owner, ws.id, 'Restrictive network', 'restricted');
    await grant(owner, place.id, member, 'viewer');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'TURN/TLS anchor', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const ownerMedia = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const memberMedia = expectStatus(await member.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;

    browser ??= await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ownerPage = await mediaPage(browser, owner.browser);
    const memberPage = await mediaPage(browser, member.browser);
    await Promise.all([connect(ownerPage, ownerMedia), connect(memberPage, memberMedia)]);
    await ownerPage.evaluate(async () => {
      const room = (window as Window & { fluxRoom?: { localParticipant: {
        publishTrack(track: MediaStreamTrack): Promise<unknown> } }; fluxAudioContext?: AudioContext;
        fluxVideoTimer?: number }).fluxRoom;
      if (!room) throw new Error('Owner room absent');
      // A generated Web Audio tone is an actual encoded track without asking
      // a microphone or assuming getUserMedia on this private HTTP test origin.
      const context = new AudioContext();
      (window as Window & { fluxAudioContext?: AudioContext }).fluxAudioContext = context;
      await context.resume();
      const oscillator = context.createOscillator();
      const output = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(output);
      oscillator.start();
      await room.localParticipant.publishTrack(output.stream.getAudioTracks()[0]!);
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const brush = canvas.getContext('2d');
      if (!brush) throw new Error('Canvas unavailable');
      let frame = 0;
      brush.fillStyle = '#172033';
      brush.fillRect(0, 0, canvas.width, canvas.height);
      brush.fillStyle = '#f4f8ff';
      brush.font = '20px monospace';
      brush.fillText(`Flux receiver quality frame ${++frame}`, 20, 48);
      (window as Window & { fluxVideoTimer?: number }).fluxVideoTimer = window.setInterval(() => {
        brush.fillStyle = '#172033';
        brush.fillRect(0, 0, canvas.width, canvas.height);
        brush.fillStyle = '#f4f8ff';
        brush.font = '20px monospace';
        brush.fillText(`Flux receiver quality frame ${++frame}`, 20, 48);
      }, 67);
      await room.localParticipant.publishTrack(canvas.captureStream(15).getVideoTracks()[0]!);
    });
    await memberPage.waitForFunction(() => {
      const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
        audioTrackPublications: Map<string, { isSubscribed: boolean }>;
        videoTrackPublications: Map<string, { isSubscribed: boolean }> }> } }).fluxRoom;
      return [...(room?.remoteParticipants.values() ?? [])].some((participant) =>
        [...participant.audioTrackPublications.values()].some((track) => track.isSubscribed) &&
        [...participant.videoTrackPublications.values()].some((track) => track.isSubscribed));
    }, undefined, { timeout: 20_000 });
    await memberPage.evaluate(() => {
      const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
        videoTrackPublications: Map<string, { track?: { attach(): HTMLVideoElement } }> }> } }).fluxRoom;
      for (const participant of room?.remoteParticipants.values() ?? []) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.track) document.body.append(publication.track.attach());
        }
      }
    });
    await memberPage.waitForFunction(async () => {
      const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
      for (const pc of pcs) {
        const stats = await pc.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'audio' &&
            report.packetsReceived >= 3 && report.bytesReceived > 0) {
            const video = [...stats.values()].find((item) => item.type === 'inbound-rtp' &&
              item.kind === 'video' && item.packetsReceived >= 3 && item.bytesReceived > 0 &&
              item.framesDecoded > 0);
            if (video) return true;
          }
        }
      }
      return false;
    }, undefined, { timeout: 20_000 });

    const ownerCandidates = await selectedCandidates(ownerPage);
    const memberCandidates = await selectedCandidates(memberPage);
    assert.ok(ownerCandidates.length > 0 && memberCandidates.length > 0,
      'both browsers must expose a selected ICE candidate pair');
    for (const candidate of [...ownerCandidates, ...memberCandidates]) {
      assert.equal(candidate.candidateType, 'relay', JSON.stringify(candidate));
      // A TURN/TLS allocation yields a UDP relay candidate. `protocol` is
      // the relayed candidate's transport; `relayProtocol` is the TCP/TLS
      // client-to-TURN hop we need to prove here.
      assert.equal(candidate.protocol, 'udp', JSON.stringify(candidate));
      assert.equal(candidate.relayProtocol, 'tls', JSON.stringify(candidate));
    }
    assert.ok(memberCandidates.some((candidate) => candidate.bytesReceived > 0),
      'receiver must get data from the SFU through the relay');
    const initialReports = await receiverReports(memberPage);
    await delay(2_000);
    const baselineReports = await receiverReports(memberPage);
    const baseline = readReceiverSample(baselineReports, initialReports, 2_000);
    assert.ok(baseline.tracks.some((track) => track.kind === 'audio' && (track.packetsReceived ?? 0) > 0),
      'receiver must expose inbound audio stats');
    assert.ok(baseline.tracks.some((track) => track.kind === 'video' && (track.packetsReceived ?? 0) > 0 &&
      (track.width ?? 0) > 0 && (track.height ?? 0) > 0 && track.fps !== undefined),
    'receiver must expose decoded video dimensions and fps');

    // Fixed netem delay is reproducible and does not pretend to model random
    // loss, jitter, a real Wi-Fi network or a hardware device.
    const mediaIp = execFileSync('getent', ['ahostsv4', 'livekit'], { encoding: 'utf8' }).split(/\s+/)[0]!;
    const route = execFileSync('ip', ['route', 'get', mediaIp], { encoding: 'utf8' });
    const iface = route.match(/\bdev (\S+)/)?.[1];
    assert.ok(iface, `cannot find client route to ${mediaIp}: ${route}`);
    let weak = baseline;
    let quality = assessReceiverQuality(weak, ['audio', 'video']);
    execFileSync('tc', ['qdisc', 'replace', 'dev', iface, 'root', 'netem', 'delay', '450ms']);
    try {
      const start = Date.now();
      const beforeWeak = await receiverReports(memberPage);
      for (let attempt = 0; attempt < 25; attempt++) {
        await delay(1_000);
        weak = readReceiverSample(await receiverReports(memberPage), beforeWeak, Date.now() - start);
        quality = assessReceiverQuality(weak, ['audio', 'video']);
        if (weak.rttMs !== undefined && weak.rttMs > RECEIVER_QUALITY_LIMITS.rttWarningMs &&
          weak.tracks.some((track) => track.kind === 'audio' && (track.bitrateKbps ?? 0) > 0) &&
          weak.tracks.some((track) => track.kind === 'video' && (track.bitrateKbps ?? 0) > 0)) break;
      }
      assert.ok(weak.rttMs !== undefined && weak.rttMs > RECEIVER_QUALITY_LIMITS.rttWarningMs,
        `selected receiver RTT did not reflect 450ms netem delay: ${JSON.stringify(weak)}`);
      assert.notEqual(quality.status, 'good', JSON.stringify(quality));
      assert.ok(quality.warnings.some((warning) => warning.includes('Network round trip')),
        JSON.stringify(quality));
      assert.ok(weak.tracks.some((track) => track.kind === 'audio' && (track.bitrateKbps ?? 0) > 0),
        'audio must still reach the receiver under fixed delay');
      assert.ok(weak.tracks.some((track) => track.kind === 'video' && (track.bitrateKbps ?? 0) > 0),
        'video must still reach the receiver under fixed delay');
    } finally {
      execFileSync('tc', ['qdisc', 'del', 'dev', iface, 'root']);
    }
    let betweenProfiles = weak;
    for (let attempt = 0; attempt < 10; attempt++) {
      const prior = await receiverReports(memberPage);
      await delay(1_000);
      betweenProfiles = readReceiverSample(await receiverReports(memberPage), prior, 1_000);
      if (betweenProfiles.rttMs !== undefined &&
        betweenProfiles.rttMs < RECEIVER_QUALITY_LIMITS.rttWarningMs &&
        betweenProfiles.tracks.some((track) => track.kind === 'audio' && (track.packetsDelta ?? 0) > 0) &&
        betweenProfiles.tracks.some((track) => track.kind === 'video' && (track.framesDelta ?? 0) > 0)) break;
    }
    assert.ok(betweenProfiles.rttMs !== undefined &&
      betweenProfiles.rttMs < RECEIVER_QUALITY_LIMITS.rttWarningMs,
    `first impairment must clear before testing packet loss: ${JSON.stringify(betweenProfiles)}`);
    // A fixed netem profile now introduces variable delay and packet drops
    // on the client's outbound interface. TURN/TLS carries media over TCP:
    // kernel drops can become retransmission/latency rather than RTP loss.
    // This image's iproute2 does not support a random seed: the configured
    // impairment is repeatable, while the exact random drop sequence varies.
    let lossy = baseline;
    let lossyQuality = assessReceiverQuality(lossy, ['audio', 'video']);
    let qdisc = '';
    execFileSync('tc', ['qdisc', 'replace', 'dev', iface, 'root', 'netem',
      'delay', '350ms', '80ms', 'distribution', 'normal', 'loss', 'random', '15%']);
    try {
      const start = Date.now();
      const beforeLossy = await receiverReports(memberPage);
      for (let attempt = 0; attempt < 25; attempt++) {
        await delay(1_000);
        lossy = readReceiverSample(await receiverReports(memberPage), beforeLossy, Date.now() - start);
        lossyQuality = assessReceiverQuality(lossy, ['audio', 'video']);
        qdisc = execFileSync('tc', ['-s', 'qdisc', 'show', 'dev', iface], { encoding: 'utf8' });
        if (lossy.rttMs !== undefined && lossy.rttMs > RECEIVER_QUALITY_LIMITS.rttWarningMs &&
          Number(qdisc.match(/dropped (\d+)/)?.[1] ?? 0) > 0 &&
          lossy.tracks.some((track) => track.kind === 'audio' && (track.packetsDelta ?? 0) > 0) &&
          lossy.tracks.some((track) => track.kind === 'video' && (track.packetsDelta ?? 0) > 0)) break;
      }
      assert.ok(Number(qdisc.match(/dropped (\d+)/)?.[1] ?? 0) > 0,
        `netem must actually drop outbound packets: ${qdisc}`);
      assert.ok(lossy.rttMs !== undefined && lossy.rttMs > RECEIVER_QUALITY_LIMITS.rttWarningMs,
        `selected ICE RTT must show variable-delay impairment: ${JSON.stringify(lossy)}`);
      assert.ok(lossyQuality.warnings.some((warning) => warning.includes('Network round trip')),
        JSON.stringify(lossyQuality));
      for (const kind of ['audio', 'video'] as const)
        assert.ok(lossy.tracks.some((track) => track.kind === kind && (track.packetsDelta ?? 0) > 0),
          `${kind} must still be received under the lossy profile`);
    } finally {
      execFileSync('tc', ['qdisc', 'del', 'dev', iface, 'root']);
    }
    let recovered = lossy;
    const recoveryStart = Date.now();
    for (let attempt = 0; attempt < 25; attempt++) {
      const beforeRecovery = await receiverReports(memberPage);
      await delay(1_000);
      recovered = readReceiverSample(await receiverReports(memberPage), beforeRecovery, 1_000);
      if (recovered.rttMs !== undefined && recovered.rttMs < RECEIVER_QUALITY_LIMITS.rttWarningMs &&
        recovered.tracks.some((track) => track.kind === 'audio' && (track.packetsDelta ?? 0) > 0) &&
        recovered.tracks.some((track) => track.kind === 'video' &&
          (track.packetsDelta ?? 0) > 0 && (track.framesDelta ?? 0) > 0)) break;
    }
    assert.ok(recovered.rttMs !== undefined && recovered.rttMs < RECEIVER_QUALITY_LIMITS.rttWarningMs,
      `selected ICE RTT must recover after removing netem: ${JSON.stringify(recovered)}`);
    for (const kind of ['audio', 'video'] as const)
      assert.ok(recovered.tracks.some((track) => track.kind === kind && (track.packetsDelta ?? 0) > 0),
        `${kind} reception must recover after removing netem`);
    assert.ok(recovered.tracks.some((track) => track.kind === 'video' &&
      (track.framesDelta ?? 0) > 0),
    `video must decode fresh frames after removing netem: ${JSON.stringify(recovered)}`);
    const recoveryMs = Date.now() - recoveryStart;
    const recoveredCandidates = await selectedCandidates(memberPage);
    for (const candidate of recoveredCandidates) {
      assert.equal(candidate.candidateType, 'relay', JSON.stringify(candidate));
      assert.equal(candidate.relayProtocol, 'tls', JSON.stringify(candidate));
    }
    console.log(JSON.stringify({ ownerCandidates, memberCandidates, subscribedAudio: true,
      receivedAudioPackets: true, receivedVideo: true, baseline, weak, quality, betweenProfiles,
      lossy, lossyQuality, netemOutboundDropped: Number(qdisc.match(/dropped (\d+)/)?.[1] ?? 0),
      recovered, recoveryMs, recoveredCandidates,
      fixedClientDelayMs: 450, configuredLossPercent: 15, variableDelayMs: [350, 80],
      blocked: ['UDP to SFU', 'TCP/7881 direct ICE'], participants: 2 }));
    await Promise.all([ownerPage.close(), memberPage.close()]);
  });

test('four authorized clients receive two simultaneous code-sized screen tracks through TURN/TLS',
  { timeout: 180_000 }, async () => {
    const people = await Promise.all(['owner', 'editor', 'reviewer', 'observer']
      .map((role) => person(`screen-${role}`)));
    const [owner, editor, reviewer, observer] = people;
    const ws = await workspace(owner!, 'Four-person screen proof');
    for (const member of [editor!, reviewer!, observer!])
      await addMember(owner!, ws.id, member, 'member');
    const place = await project(owner!, ws.id, 'Readable screens', 'workspace');
    await grant(owner!, place.id, editor!, 'contributor');
    for (const member of [reviewer!, observer!])
      await grant(owner!, place.id, member, 'viewer');
    const conversation = expectStatus(await owner!.browser.request('POST',
      `/api/v1/projects/${place.id}/conversations`, {
        body: { body: 'Two screen discussion', clientMessageId: randomUUID() },
      }), 201) as Conversation;
    const session = expectStatus(await owner!.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const grants = await Promise.all(people.map(async (member) => expectStatus(
      await member!.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant));

    browser ??= await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const pages = await Promise.all(people.map((member) => mediaPage(browser!, member!.browser)));
    await Promise.all(pages.map((page, index) => connect(page, grants[index]!)));
    for (const page of pages) await page.waitForFunction(() => {
      const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, unknown> } }).fluxRoom;
      return room?.remoteParticipants.size === 3;
    }, undefined, { timeout: 30_000 });
    markResourcePhase('four_connected');
    const screens = [
      { title: 'review.ts · merge conflict', lines: [
        'const review = await loadPullRequest(124);',
        'const head = await git.resolve(review.headRef);',
        'const checks = review.requiredChecks;',
        'const reviewers = review.approvals.filter(a => a.commit === head.sha);',
        'const unresolved = review.threads.filter(t => !t.resolved);',
        'if (checks.some(check => !check.passed)) {',
        '  return { mergeable: false, reason: "CI" };',
        '}',
        'if (unresolved.length > 0 || reviewers.length === 0) {',
        '  return { mergeable: false, reason: "review" };',
        '}',
        'return { mergeable: true, commit: head.sha };',
      ] },
      { title: 'Release checklist · v0.1.0', lines: [
        '[x] Migrations run on clean database',
        '[x] Required checks match candidate commit',
        '[x] Four participants join same room',
        '[x] Two screen tracks decoded at both viewers',
        '[x] Audio RTP continues during screen sharing',
        '[ ] Verify screen text on tablet',
        '[ ] Check notification on iPhone',
        '[ ] Review TURN/TLS on external restrictive link',
        '[ ] Publish pinned container digest',
        '[ ] Verify clean self-host install guide',
        '[ ] Link release notes to closed issues',
        'Owner: Release team    Updated: today',
      ] },
    ];
    for (const [index, screen] of screens.entries()) {
      await pages[index]!.evaluate(async ({ title, lines }) => {
        const room = (window as Window & { fluxRoom?: { localParticipant: {
          publishTrack(track: MediaStreamTrack, options?: { name: string; source: string }): Promise<unknown>
        } }; fluxScreenTimer?: number }).fluxRoom;
        if (!room) throw new Error('Screen publisher room absent');
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        const brush = canvas.getContext('2d');
        if (!brush) throw new Error('Screen canvas unavailable');
        let frame = 0;
        brush.fillStyle = '#101827';
        brush.fillRect(0, 0, 960, 540);
        (window as Window & { fluxScreenTimer?: number }).fluxScreenTimer = window.setInterval(() => {
          brush.fillStyle = '#101827';
          brush.fillRect(0, 0, 960, 540);
          brush.fillStyle = '#edf3fa';
          brush.font = 'bold 18px monospace';
          brush.fillText(title, 28, 44);
          brush.fillStyle = '#acc7e0';
          brush.font = '16px monospace';
          lines.forEach((line, row) => brush.fillText(line, 28, 88 + row * 32));
          brush.fillStyle = '#92e1bd';
          brush.fillText(`LIVE · frame ${++frame}`, 28, 504);
        }, 100);
        await room.localParticipant.publishTrack(canvas.captureStream(10).getVideoTracks()[0]!,
          { name: title, source: 'screen_share' });
      }, screen);
    }
    await pages[0]!.evaluate(async () => {
      const room = (window as Window & { fluxRoom?: { localParticipant: {
        publishTrack(track: MediaStreamTrack): Promise<unknown> } }; fluxAudioContext?: AudioContext }).fluxRoom;
      if (!room) throw new Error('Audio publisher room absent');
      const context = new AudioContext();
      (window as Window & { fluxAudioContext?: AudioContext }).fluxAudioContext = context;
      await context.resume();
      const oscillator = context.createOscillator();
      const output = context.createMediaStreamDestination();
      oscillator.frequency.value = 523;
      oscillator.connect(output);
      oscillator.start();
      await room.localParticipant.publishTrack(output.stream.getAudioTracks()[0]!);
    });
    markResourcePhase('four_media_active');
    for (const page of pages.slice(2)) {
      await page.waitForFunction(() => {
        const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
          videoTrackPublications: Map<string, { isSubscribed: boolean; track?: unknown }>
        }> } }).fluxRoom;
        return [...(room?.remoteParticipants.values() ?? [])].reduce((count, participant) =>
          count + [...participant.videoTrackPublications.values()]
            .filter((pub) => pub.isSubscribed && pub.track).length, 0) >= 2;
      }, undefined, { timeout: 30_000 });
      await page.evaluate(() => {
        const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
          videoTrackPublications: Map<string, { track?: { attach(): HTMLVideoElement } }>
        }> } }).fluxRoom;
        document.body.replaceChildren();
        document.body.style.cssText = 'margin:0;background:#0b1020;display:flex;flex-direction:column;gap:16px;padding:16px';
        for (const participant of room?.remoteParticipants.values() ?? [])
          for (const publication of participant.videoTrackPublications.values())
            if (publication.track) {
              const video = publication.track.attach();
              video.style.cssText = 'width:960px;height:540px;object-fit:contain';
              document.body.append(video);
            }
      });
      await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 2 &&
        [...document.querySelectorAll('video')].every((video) => video.videoWidth >= 640 &&
          video.videoHeight >= 360 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
      undefined, { timeout: 30_000 });
      const reportsA = await receiverReports(page);
      await delay(2_000);
      const sample = readReceiverSample(await receiverReports(page), reportsA, 2_000);
      const videos = sample.tracks.filter((track) => track.kind === 'video' &&
        (track.packetsDelta ?? 0) > 0 && (track.width ?? 0) >= 640 &&
        (track.height ?? 0) >= 360 && (track.fps ?? 0) > 0);
      assert.equal(videos.length, 2, `both live screens must decode at viewer: ${JSON.stringify(sample)}`);
      assert.ok(sample.tracks.some((track) => track.kind === 'audio' && (track.packetsDelta ?? 0) > 0),
        `audio must continue with both screens at viewer: ${JSON.stringify(sample)}`);
      const candidates = await selectedCandidates(page);
      assert.ok(candidates.length > 0, 'viewer needs selected candidate pair');
      for (const candidate of candidates) {
        assert.equal(candidate.candidateType, 'relay', JSON.stringify(candidate));
        assert.equal(candidate.relayProtocol, 'tls', JSON.stringify(candidate));
      }
      await page.screenshot({ path: `/artifacts/screen-viewer-${pages.indexOf(page) + 1}.png`,
        fullPage: true });
      console.log(JSON.stringify({ screenViewer: pages.indexOf(page), sample,
        videos: await page.locator('video').evaluateAll((elements) => elements.map((item) => {
          const video = item as HTMLVideoElement;
          return { naturalWidth: video.videoWidth, naturalHeight: video.videoHeight,
            renderedWidth: video.getBoundingClientRect().width,
            renderedHeight: video.getBoundingClientRect().height };
        })), candidates }));
    }
    for (const page of pages.slice(0, 2)) {
      const candidates = await selectedCandidates(page);
      assert.ok(candidates.length > 0, 'screen publisher needs selected candidate pair');
      for (const candidate of candidates) {
        assert.equal(candidate.candidateType, 'relay', JSON.stringify(candidate));
        assert.equal(candidate.relayProtocol, 'tls', JSON.stringify(candidate));
      }
    }
    // Leave both screens flowing long enough for two independent Docker stats
    // snapshots inside the four-person measurement interval.
    await delay(2_000);
    markResourcePhase('four_media_verified');
    for (const page of pages) await page.close();
  });

test('isolated headed Chromium publishes real display capture and virtual camera/mic through TURN/TLS',
  { timeout: 180_000 }, async () => {
    const owner = await person('isolated-capture-owner');
    const viewer = await person('isolated-capture-viewer');
    const ws = await workspace(owner, 'Browser capture proof');
    await addMember(owner, ws.id, viewer, 'member');
    const place = await project(owner, ws.id, 'Xvfb source', 'workspace');
    await grant(owner, place.id, viewer, 'viewer');
    const conversation = expectStatus(await owner.browser.request('POST',
      `/api/v1/projects/${place.id}/conversations`, {
        body: { body: 'Browser media API anchor', clientMessageId: randomUUID() },
      }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const ownerMedia = expectStatus(await owner.browser.request('POST',
      `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const viewerMedia = expectStatus(await viewer.browser.request('POST',
      `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;

    // The page is on localhost because getDisplayMedia requires a trustworthy
    // origin. Xvfb supplies a separate display; browser flags substitute
    // camera/mic devices and auto-select that virtual screen, never host media.
    const captureHtml = `<!doctype html><meta charset="utf-8"><title>Flux isolated capture</title>
        <style>body{background:#172033;color:#f4f8ff;font:16px monospace;padding:24px}</style>
        <h1>Flux isolated browser capture</h1><p>const source = "Xvfb only";</p>
        <button id="share">Share isolated screen</button>
        <button id="devices">Use virtual camera and mic</button>
        <script>
          document.querySelector('#share').addEventListener('click', () => {
            window.screenPending = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          });
          document.querySelector('#devices').addEventListener('click', () => {
            window.devicesPending = navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          });
        </script>`;
    let publisherBrowser: Browser | undefined;
    let viewerBrowser: Browser | undefined;
    try {
      publisherBrowser = await chromium.launch({ headless: false, args: [
        '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
      ] });
      viewerBrowser = await chromium.launch({ args: ['--no-sandbox'] });
      const publisherPage = await mediaPage(publisherBrowser, owner.browser);
      await publisherPage.setViewportSize({ width: 1280, height: 800 });
      await connect(publisherPage, ownerMedia);
      // Keep the real same-origin network path. Document content supplies only
      // the isolated capture buttons; no request interception touches signaling.
      await publisherPage.setContent(captureHtml);
      assert.equal(await publisherPage.evaluate(() =>
        (window as Window & { fluxRoom?: { state: string } }).fluxRoom?.state), 'connected');
      assert.equal(await publisherPage.evaluate(() => window.isSecureContext), true,
        'localhost capture page must be a secure context');
      await publisherPage.click('#share');
      const screen = await publisherPage.evaluate(async () => {
        const w = window as Window & { screenPending?: Promise<MediaStream>; fluxRoom?: {
          localParticipant: { publishTrack(track: MediaStreamTrack,
            options: { source: string }): Promise<unknown> } } };
        const stream = await Promise.race([w.screenPending,
          new Promise<never>((_resolve, reject) => window.setTimeout(() =>
            reject(new Error('Xvfb display picker did not produce a stream in 25 seconds')), 25_000))]);
        const track = stream?.getVideoTracks()[0];
        if (!track || !w.fluxRoom) throw new Error('Display capture or live room unavailable');
        await w.fluxRoom.localParticipant.publishTrack(track, { source: 'screen_share' });
        return { readyState: track.readyState, settings: track.getSettings() };
      });
      assert.equal(screen.readyState, 'live');
      assert.ok((screen.settings.width ?? 0) > 0 && (screen.settings.height ?? 0) > 0,
        `display capture must expose real track dimensions: ${JSON.stringify(screen)}`);

      await publisherPage.click('#devices');
      const devices = await publisherPage.evaluate(async () => {
        const w = window as Window & { devicesPending?: Promise<MediaStream>; fluxRoom?: {
          localParticipant: { publishTrack(track: MediaStreamTrack,
            options: { source: string }): Promise<unknown> } } };
        const stream = await Promise.race([w.devicesPending,
          new Promise<never>((_resolve, reject) => window.setTimeout(() =>
            reject(new Error('Virtual camera/microphone did not produce a stream in 25 seconds')), 25_000))]);
        const camera = stream?.getVideoTracks()[0];
        const microphone = stream?.getAudioTracks()[0];
        if (!camera || !microphone || !w.fluxRoom)
          throw new Error('Virtual camera/microphone or live room unavailable');
        await w.fluxRoom.localParticipant.publishTrack(camera, { source: 'camera' });
        await w.fluxRoom.localParticipant.publishTrack(microphone, { source: 'microphone' });
        return { camera: camera.getSettings(), microphoneState: microphone.readyState };
      });
      assert.ok((devices.camera.width ?? 0) > 0 && (devices.camera.height ?? 0) > 0);
      assert.equal(devices.microphoneState, 'live');

      const viewerPage = await mediaPage(viewerBrowser, viewer.browser);
      await connect(viewerPage, viewerMedia);
      await viewerPage.waitForFunction(() => {
        const w = window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
          audioTrackPublications: Map<string, { isSubscribed: boolean }>;
          videoTrackPublications: Map<string, { isSubscribed: boolean }>
        }> } };
        const remote = [...(w.fluxRoom?.remoteParticipants.values() ?? [])];
        const twoVideos = remote.some((person) =>
          [...person.videoTrackPublications.values()].filter((pub) => pub.isSubscribed).length >= 2);
        const audio = remote.some((person) =>
          [...person.audioTrackPublications.values()].some((pub) => pub.isSubscribed));
        return twoVideos && audio;
      }, undefined, { timeout: 40_000 });
      await viewerPage.evaluate(() => {
        const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
          videoTrackPublications: Map<string, { track?: { attach(): HTMLVideoElement } }>
        }> } }).fluxRoom;
        document.body.replaceChildren();
        document.body.style.cssText = 'margin:0;background:#0b1020;display:flex;gap:12px';
        for (const person of room?.remoteParticipants.values() ?? [])
          for (const publication of person.videoTrackPublications.values())
            if (publication.track) {
              const video = publication.track.attach();
              video.style.cssText = 'width:640px;max-height:800px;object-fit:contain';
              document.body.append(video);
            }
      });
      await viewerPage.waitForFunction(async () => {
        const w = window as Window & { fluxPcs?: RTCPeerConnection[] };
        const stats = (await Promise.all((w.fluxPcs ?? []).map((pc) => pc.getStats())))
          .flatMap((report) => [...report.values()]);
        return stats.filter((item) => item.type === 'inbound-rtp' && item.kind === 'video' &&
          item.framesDecoded > 0).length >= 2 && stats.some((item) =>
          item.type === 'inbound-rtp' && item.kind === 'audio' && item.packetsReceived >= 3);
      }, undefined, { timeout: 40_000 });
      await viewerPage.screenshot({ path: '/artifacts/isolated-device-viewer.png', fullPage: true });
      const publisherCandidates = await selectedCandidates(publisherPage);
      const viewerCandidates = await selectedCandidates(viewerPage);
      assert.ok(publisherCandidates.length > 0 && viewerCandidates.length > 0);
      for (const candidate of [...publisherCandidates, ...viewerCandidates]) {
        assert.equal(candidate.candidateType, 'relay', JSON.stringify(candidate));
        assert.equal(candidate.relayProtocol, 'tls', JSON.stringify(candidate));
      }
      console.log(JSON.stringify({ isolatedCapture: true, screen, devices,
        publisherCandidates, viewerCandidates, physicalDevicesUsed: false,
        display: 'separate Xvfb display' }));
    } finally {
      await Promise.all([publisherBrowser?.close(), viewerBrowser?.close()]);
    }
  });
