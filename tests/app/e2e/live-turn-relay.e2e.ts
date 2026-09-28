import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

let browser: Browser | undefined;
after(async () => browser?.close());

type CandidateEvidence = { candidateType: string; protocol: string; relayProtocol?: string;
  pairState: string; bytesSent: number; bytesReceived: number };

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
  { timeout: 120_000 }, async () => {
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

    browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ownerPage = await browser.newPage();
    const memberPage = await browser.newPage();
    await Promise.all([connect(ownerPage, ownerMedia), connect(memberPage, memberMedia)]);
    await ownerPage.evaluate(async () => {
      const room = (window as Window & { fluxRoom?: { localParticipant: {
        publishTrack(track: MediaStreamTrack): Promise<unknown> } }; fluxAudioContext?: AudioContext }).fluxRoom;
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
    });
    await memberPage.waitForFunction(() => {
      const room = (window as Window & { fluxRoom?: { remoteParticipants: Map<string, {
        audioTrackPublications: Map<string, { isSubscribed: boolean }> }> } }).fluxRoom;
      return [...(room?.remoteParticipants.values() ?? [])].some((participant) =>
        [...participant.audioTrackPublications.values()].some((track) => track.isSubscribed));
    }, undefined, { timeout: 20_000 });
    await memberPage.waitForFunction(async () => {
      const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
      for (const pc of pcs) {
        const stats = await pc.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'audio' &&
            report.packetsReceived >= 3 && report.bytesReceived > 0) return true;
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
    console.log(JSON.stringify({ ownerCandidates, memberCandidates, subscribedAudio: true,
      receivedAudioPackets: true, blocked: ['UDP to SFU', 'TCP/7881 direct ICE'], participants: 2 }));
  });
