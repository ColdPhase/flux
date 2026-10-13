import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';
import { mediaPage } from '../support/live-sfu.js';
import { connect, dtlsSrtpViolations, dtlsTransports, receiverReports, selectedCandidates } from '../support/live-turn.js';

/**
 * DTLS-SRTP on the direct path (#63 AC-4). Unlike the TURN/TLS proof, nothing here restricts UDP:
 * authorized Chromium clients reach the pinned SFU on its own ICE candidates. Every transport that
 * carries RTP must complete DTLS with the signalled certificate, and the selected pair must not be
 * a relay. A tampered fingerprint on this same path must fail. Run only through
 * scripts/check_live_sfu.sh; the ordinary PR suite has no SFU.
 */
let browser: Browser | undefined;
after(async () => browser?.close());

/** A generated tone needs no microphone device or permission prompt on this HTTP test origin. */
async function publishTone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as Window & { fluxRoom?: { localParticipant: {
      publishTrack(track: MediaStreamTrack): Promise<unknown> } }; fluxAudioContext?: AudioContext };
    if (!w.fluxRoom) throw new Error('Room absent');
    const context = new AudioContext();
    w.fluxAudioContext = context;
    await context.resume();
    const oscillator = context.createOscillator();
    const output = context.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(output);
    oscillator.start();
    await w.fluxRoom.localParticipant.publishTrack(output.stream.getAudioTracks()[0]!);
  });
}

async function setup(name: string, members: string[]) {
  const owner = await person(`${name}-owner`);
  const others = await Promise.all(members.map((member) => person(`${name}-${member}`)));
  const ws = await workspace(owner, 'Direct DTLS');
  for (const other of others) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Direct path', 'restricted');
  for (const other of others) await grant(owner, place.id, other, 'viewer');
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Direct DTLS anchor', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
    body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
  }), 201) as LiveSession;
  const join = async (who: typeof owner) => expectStatus(await who.browser.request('POST',
    `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
  return { owner, others, ownerMedia: await join(owner), otherMedia: await Promise.all(others.map(join)) };
}

test('direct path: both clients complete DTLS-SRTP with the signalled certificate on a non-relay pair',
  { timeout: 180_000 }, async () => {
    const { owner, others, ownerMedia, otherMedia } = await setup('direct', ['member']);
    browser ??= await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ownerPage = await mediaPage(browser, owner.browser);
    const memberPage = await mediaPage(browser, others[0]!.browser);
    await Promise.all([connect(ownerPage, ownerMedia), connect(memberPage, otherMedia[0]!)]);
    await publishTone(ownerPage);

    // Read the evidence only once RTP flows: owner outbound RTP bytes and member inbound RTP packets.
    // Candidate-pair byte counts alone also include non-RTP DTLS traffic, so they cannot show media.
    for (let attempt = 0; attempt < 120; attempt++) {
      const sent = (await dtlsTransports(ownerPage)).some((transport) => transport.rtpBytes > 0);
      const received = (await receiverReports(memberPage)).some((report) =>
        report.type === 'inbound-rtp' && (report.packetsReceived ?? 0) > 0);
      if (sent && received) break;
      await delay(500);
    }
    const ownerCandidates = await selectedCandidates(ownerPage);
    const memberCandidates = await selectedCandidates(memberPage);
    assert.ok(ownerCandidates.length > 0 && memberCandidates.length > 0,
      'both browsers must expose a selected ICE candidate pair');
    for (const candidate of [...ownerCandidates, ...memberCandidates]) {
      assert.notEqual(candidate.candidateType, 'relay', JSON.stringify(candidate));
      assert.equal(candidate.relayProtocol, undefined, JSON.stringify(candidate));
    }
    assert.ok(memberCandidates.some((pair) => pair.bytesReceived > 0),
      'receiver must get RTP from the SFU over the direct pair');
    const ownerDtls = await dtlsTransports(ownerPage);
    const memberDtls = await dtlsTransports(memberPage);
    assert.deepEqual(dtlsSrtpViolations(ownerDtls), [], JSON.stringify(ownerDtls));
    assert.deepEqual(dtlsSrtpViolations(memberDtls), [], JSON.stringify(memberDtls));
    console.log(JSON.stringify({ directDtls: { owner: ownerDtls, member: memberDtls,
      selected: { owner: ownerCandidates, member: memberCandidates } } }));
    await Promise.all([ownerPage, memberPage].map((page) => page.evaluate(async () => {
      await (window as Window & { fluxRoom?: { disconnect(): Promise<void> } }).fluxRoom?.disconnect();
    }).catch(() => undefined)));
    await Promise.all([ownerPage.close(), memberPage.close()]);
  });

test('negative control, direct path: a tampered SFU fingerprint fails DTLS and carries no media',
  { timeout: 120_000 }, async () => {
    const { others, otherMedia } = await setup('direct-control', ['probe']);
    browser ??= await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await mediaPage(browser, others[0]!.browser);
    // The same grant, signalling gate and UDP path as the positive case; only the fingerprint the
    // browser expects is wrong. The SDK's own connect timeout bounds this attempt.
    let connectOutcome = 'resolved';
    try { await connect(page, otherMedia[0]!, undefined, false, { tamperRemoteFingerprint: true }); }
    catch (error) { connectOutcome = String(error).slice(0, 600); }
    type State = { pc: number; ice?: string; connection?: string; dtls?: string };
    type Failed = { pc: number; dtlsState?: string; srtpCipher?: string; inboundRtpBytes: number };
    await page.waitForFunction(() => ((window as Window & { fluxPcStates?: State[] }).fluxPcStates ?? [])
      .some((state) => state.connection === 'failed'), undefined, { timeout: 60_000 });
    let states: State[] = [];
    let failed: Failed[] = [];
    for (let attempt = 0; attempt < 20 && !failed.length; attempt++) {
      await delay(250);
      ({ states, failed } = await page.evaluate(() => {
        const w = window as Window & { fluxPcStates?: State[]; fluxFailedTransports?: Failed[] };
        return { states: w.fluxPcStates ?? [], failed: w.fluxFailedTransports ?? [] };
      }));
    }
    const evidence = JSON.stringify({ connectOutcome, states, failed });
    const iceConnected = new Set(states.filter((state) => state.ice === 'connected' || state.ice === 'completed')
      .map((state) => state.pc));
    assert.ok(states.some((state) => state.connection === 'failed' && iceConnected.has(state.pc)),
      `ICE must reach the SFU before the connection fails, so the failure is DTLS: ${evidence}`);
    assert.ok(states.some((state) => state.dtls === 'failed'), `DTLS transport must fail: ${evidence}`);
    assert.equal(states.some((state) => state.connection === 'connected' || state.dtls === 'connected'), false,
      `no connection may complete with another certificate: ${evidence}`);
    assert.ok(failed.length > 0, `failed transport stats must be captured: ${evidence}`);
    for (const transport of failed) {
      assert.notEqual(transport.dtlsState, 'connected', evidence);
      assert.ok(!transport.srtpCipher, `no SRTP keys may be derived: ${evidence}`);
      assert.equal(transport.inboundRtpBytes, 0, `no media may be received: ${evidence}`);
    }
    assert.notDeepEqual(dtlsSrtpViolations(await dtlsTransports(page)), [], evidence);
    console.log(JSON.stringify({ directDtlsNegativeControl: { connectOutcome, states, failed } }));
    await page.close();
  });
