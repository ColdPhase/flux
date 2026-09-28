import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { assessReceiverQuality, readReceiverSample, RECEIVER_QUALITY_LIMITS,
  type RtcStatsRecord } from '../../../apps/web/src/live/receiver-quality.js';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

let browser: Browser | undefined;
after(async () => browser?.close());

type CandidateEvidence = { candidateType: string; protocol: string; relayProtocol?: string;
  pairState: string; bytesSent: number; bytesReceived: number };

async function receiverReports(page: Page): Promise<RtcStatsRecord[]> {
  return page.evaluate(async () => {
    const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
    const records: RtcStatsRecord[] = [];
    for (const [index, pc] of pcs.entries()) {
      for (const report of (await pc.getStats()).values()) {
        records.push({ id: `${index}:${report.id}`, type: report.type,
          kind: report.kind, selected: report.selected,
          selectedCandidatePairId: report.selectedCandidatePairId
            ? `${index}:${report.selectedCandidatePairId}` : undefined,
          currentRoundTripTime: report.currentRoundTripTime,
          packetsReceived: report.packetsReceived, packetsLost: report.packetsLost,
          bytesReceived: report.bytesReceived, jitter: report.jitter,
          framesPerSecond: report.framesPerSecond, framesDecoded: report.framesDecoded,
          frameWidth: report.frameWidth, frameHeight: report.frameHeight });
      }
    }
    return records;
  });
}

async function connect(page: Page, media: LiveJoinGrant): Promise<void> {
  await page.goto(media.mediaUrl.replace(/^ws/, 'http'));
  await page.evaluate(() => {
    const pcs: RTCPeerConnection[] = [];
    const w = window as Window & { fluxPcs?: RTCPeerConnection[]; fluxIceErrors?: unknown[];
      fluxIceEvents?: unknown[] };
    w.fluxPcs = pcs;
    w.fluxIceErrors = [];
    w.fluxIceEvents = [];
    const original = window.RTCPeerConnection;
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true,
      value: new Proxy(original, { construct(target, args) {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        pcs.push(pc);
        pc.addEventListener('icecandidateerror', (event) => {
          const failure = event as RTCPeerConnectionIceErrorEvent;
          w.fluxIceErrors?.push({ url: failure.url, code: failure.errorCode, text: failure.errorText });
        });
        pc.addEventListener('icecandidate', (event) => {
          w.fluxIceEvents?.push({ candidate: event.candidate?.candidate,
            type: event.candidate?.type, protocol: event.candidate?.protocol,
            address: event.candidate?.address });
        });
        pc.addEventListener('icegatheringstatechange', () => w.fluxIceEvents?.push({ gathering: pc.iceGatheringState }));
        pc.addEventListener('iceconnectionstatechange', () => w.fluxIceEvents?.push({ connection: pc.iceConnectionState }));
        return pc;
      } }) });
  });
  await page.addScriptTag({ path: '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js' });
  try { await page.evaluate(async ({ url, token }) => {
    const w = window as Window & { LivekitClient?: { Room: new () => {
      connect(url: string, token: string): Promise<void>; localParticipant: {
        publishTrack(track: MediaStreamTrack): Promise<unknown> }; remoteParticipants: Map<string, unknown>;
        state: string; disconnect(): Promise<void> } }; fluxRoom?: unknown };
    const sdk = w.LivekitClient;
    if (!sdk) throw new Error('Pinned LiveKit browser SDK missing');
    const room = new sdk.Room();
    w.fluxRoom = room;
    await room.connect(url, token);
  }, { url: media.mediaUrl, token: media.token }); }
  catch (error) {
    const diagnosis = await page.evaluate(async () => {
      const w = window as Window & { fluxPcs?: RTCPeerConnection[]; fluxIceErrors?: unknown[];
        fluxIceEvents?: unknown[] };
      return { errors: w.fluxIceErrors, events: w.fluxIceEvents,
        pcs: await Promise.all((w.fluxPcs ?? []).map(async (pc) => ({
        state: pc.iceConnectionState,
        iceServers: pc.getConfiguration().iceServers?.map((server) => server.urls),
        candidates: [...(await pc.getStats()).values()].filter((item) =>
          item.type === 'local-candidate' || item.type === 'candidate-pair').map((item) => ({
          type: item.type, candidateType: item.candidateType, protocol: item.protocol,
          relayProtocol: item.relayProtocol, url: item.url, state: item.state,
          selected: item.selected, localCandidateId: item.localCandidateId,
        })),
      }))) };
    });
    throw new Error(`Browser ICE connection failed: ${String(error)}; ${JSON.stringify(diagnosis)}`);
  }
}

async function selectedCandidates(page: Page): Promise<CandidateEvidence[]> {
  return page.evaluate(async () => {
    const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
    const evidence: CandidateEvidence[] = [];
    for (const pc of pcs) {
      const stats = await pc.getStats();
      const selectedIds = new Set<string>();
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId)
          selectedIds.add(report.selectedCandidatePairId);
      });
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded' ||
          !(selectedIds.has(report.id) || report.selected)) return;
        const candidate = stats.get(report.localCandidateId);
        if (!candidate) return;
        evidence.push({ candidateType: candidate.candidateType, protocol: candidate.protocol,
          relayProtocol: candidate.relayProtocol, pairState: report.state,
          bytesSent: report.bytesSent ?? 0, bytesReceived: report.bytesReceived ?? 0 });
      });
    }
    return evidence;
  });
}

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
    const ownerPage = await browser.newPage();
    const memberPage = await browser.newPage();
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
    assert.ok(baseline.tracks.some((track) => track.kind === 'audio' && track.packetsReceived > 0),
      'receiver must expose inbound audio stats');
    assert.ok(baseline.tracks.some((track) => track.kind === 'video' && track.packetsReceived > 0 &&
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
    const pages = await Promise.all(grants.map(() => browser!.newPage()));
    await Promise.all(pages.map((page, index) => connect(page, grants[index]!)));
    for (const page of pages) await page.waitForFunction(() => {
      const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, unknown> } }).fluxRoom;
      return room?.remoteParticipants.size === 3;
    }, undefined, { timeout: 30_000 });
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
    for (const page of pages) await page.close();
  });
