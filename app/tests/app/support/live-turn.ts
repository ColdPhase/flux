import { appendFileSync } from 'node:fs';
import type { Page } from 'playwright';
import type { LiveJoinGrant } from '@flux/contracts';
import type { RtcStatsRecord } from '../../../apps/web/src/live/receiver-quality.js';
import { publicOrigin } from './http.js';

export function markResourcePhase(phase: string): void {
  appendFileSync('/artifacts/livekit-phases.jsonl',
    `${JSON.stringify({ timestampUtc: new Date().toISOString(), phase })}\n`);
}

type CandidateEvidence = { candidateType: string; protocol: string; relayProtocol?: string;
  pairState: string; bytesSent: number; bytesReceived: number };

export async function receiverReports(page: Page): Promise<RtcStatsRecord[]> {
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

/**
 * One browser transport as W3C webrtc-stats `RTCTransportStats` reports it, with the remote
 * DTLS certificate it authenticated and the `a=fingerprint` values of the remote description
 * that reached the browser through Flux signaling (docs/development/live-media-encryption.md).
 */
export type DtlsTransportEvidence = {
  pc: number; id: string; dtlsState?: string; iceState?: string; tlsVersion?: string;
  dtlsCipher?: string; srtpCipher?: string; dtlsRole?: string;
  remoteFingerprintAlgorithm?: string; remoteFingerprint?: string;
  /** `<algorithm> <FINGERPRINT>` for each `a=fingerprint` line of the remote description. */
  signalledFingerprints: string[];
  /** Bytes of the inbound and outbound RTP streams that use this transport. */
  rtpBytes: number;
};

export async function dtlsTransports(page: Page): Promise<DtlsTransportEvidence[]> {
  return page.evaluate(async () => {
    const pcs = (window as Window & { fluxPcs?: RTCPeerConnection[] }).fluxPcs ?? [];
    const evidence: DtlsTransportEvidence[] = [];
    for (const [index, pc] of pcs.entries()) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      const signalled = [...(pc.remoteDescription?.sdp ?? '').matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gm)]
        .map((line) => `${line[1]!.toLowerCase()} ${line[2]!.toUpperCase()}`);
      stats.forEach((report) => {
        if (report.type !== 'transport') return;
        const certificate = report.remoteCertificateId ? stats.get(report.remoteCertificateId) : undefined;
        let rtpBytes = 0;
        stats.forEach((stream) => {
          if (stream.transportId !== report.id) return;
          if (stream.type === 'inbound-rtp') rtpBytes += stream.bytesReceived ?? 0;
          if (stream.type === 'outbound-rtp') rtpBytes += stream.bytesSent ?? 0;
        });
        evidence.push({ pc: index, id: report.id, dtlsState: report.dtlsState, iceState: report.iceState,
          tlsVersion: report.tlsVersion, dtlsCipher: report.dtlsCipher, srtpCipher: report.srtpCipher,
          dtlsRole: report.dtlsRole, remoteFingerprintAlgorithm: certificate?.fingerprintAlgorithm,
          remoteFingerprint: certificate?.fingerprint, signalledFingerprints: signalled, rtpBytes });
      });
    }
    return evidence;
  });
}

/**
 * Why these transports do not prove DTLS-SRTP media; empty when they do. Every transport that
 * carried RTP must have completed DTLS 1.2 or 1.3 (RFC 8996 forbids 1.0) with a cipher suite and
 * an SRTP protection profile, and its peer's certificate must be the one whose fingerprint the
 * remote description carried (RFC 8827 §4.3, 6.5).
 */
export function dtlsSrtpViolations(transports: DtlsTransportEvidence[]): string[] {
  const media = transports.filter((transport) => transport.rtpBytes > 0);
  if (!media.length) return ['no transport carried RTP bytes'];
  const problems: string[] = [];
  for (const transport of media) {
    const where = `pc${transport.pc}/${transport.id}`;
    if (transport.dtlsState !== 'connected') problems.push(`${where}: dtlsState ${transport.dtlsState}`);
    if (!transport.srtpCipher) problems.push(`${where}: no SRTP protection profile`);
    if (!transport.dtlsCipher) problems.push(`${where}: no DTLS cipher suite`);
    // Four hex digits of the negotiated version: FEFD is DTLS 1.2, FEFC DTLS 1.3.
    if (!/^FE(FD|FC)$/i.test(transport.tlsVersion ?? '')) problems.push(`${where}: DTLS version ${transport.tlsVersion}`);
    if (!transport.remoteFingerprint || !transport.remoteFingerprintAlgorithm)
      problems.push(`${where}: no remote DTLS certificate`);
    else if (!transport.signalledFingerprints.includes(
      `${transport.remoteFingerprintAlgorithm.toLowerCase()} ${transport.remoteFingerprint.toUpperCase()}`))
      problems.push(`${where}: remote certificate is not the signalled fingerprint`);
  }
  return problems;
}

export type ConnectOptions = {
  /**
   * Negative control only: every remote description the page applies gets each `a=fingerprint`
   * byte inverted, so the browser expects a certificate the SFU does not have. ICE can still
   * connect; DTLS must then fail and no media key exists. Records each connection's ICE,
   * overall and DTLS states in `window.fluxPcStates`, and its transport stats when it fails in
   * `window.fluxFailedTransports`.
   */
  tamperRemoteFingerprint?: boolean;
};

export async function connect(page: Page, media: LiveJoinGrant, pageUrl?: string, relayOnly = false,
  options: ConnectOptions = {}): Promise<void> {
  const signaling: { path: string; status?: number; error?: string; frames?: number }[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/media/'))
      signaling.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  page.on('requestfailed', (request) => signaling.push({
    path: new URL(request.url()).pathname, error: request.failure()?.errorText,
  }));
  page.on('websocket', (socket) => {
    const record = { path: new URL(socket.url()).pathname, frames: 0, error: undefined as string | undefined };
    signaling.push(record);
    socket.on('framereceived', () => { record.frames += 1; });
    socket.on('socketerror', (error) => { record.error = error; });
  });
  await page.goto(pageUrl ?? `${publicOrigin}/api/v1/health`);
  await page.evaluate((tamper) => {
    const pcs: RTCPeerConnection[] = [];
    const w = window as Window & { fluxPcs?: RTCPeerConnection[]; fluxIceErrors?: unknown[];
      fluxIceEvents?: unknown[]; fluxPcStates?: { pc: number; ice?: string; connection?: string; dtls?: string }[];
      fluxFailedTransports?: Record<string, unknown>[] };
    w.fluxPcs = pcs;
    w.fluxIceErrors = [];
    w.fluxIceEvents = [];
    w.fluxPcStates = [];
    w.fluxFailedTransports = [];
    const original = window.RTCPeerConnection;
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true,
      value: new Proxy(original, { construct(target, args) {
        const pc = Reflect.construct(target, args) as RTCPeerConnection;
        const index = pcs.length;
        pcs.push(pc);
        if (tamper) {
          const states = w.fluxPcStates!;
          pc.addEventListener('iceconnectionstatechange', () => states.push({ pc: index, ice: pc.iceConnectionState }));
          pc.addEventListener('connectionstatechange', () => {
            states.push({ pc: index, connection: pc.connectionState });
            if (pc.connectionState !== 'failed') return;
            void pc.getStats().then((stats) => stats.forEach((report) => {
              if (report.type !== 'transport') return;
              let inboundRtpBytes = 0;
              stats.forEach((stream) => {
                if (stream.type === 'inbound-rtp' && stream.transportId === report.id)
                  inboundRtpBytes += stream.bytesReceived ?? 0;
              });
              w.fluxFailedTransports!.push({ pc: index, id: report.id, dtlsState: report.dtlsState,
                iceState: report.iceState, tlsVersion: report.tlsVersion, dtlsCipher: report.dtlsCipher,
                srtpCipher: report.srtpCipher, inboundRtpBytes });
            })).catch(() => undefined);
          });
          const watched = new WeakSet<RTCDtlsTransport>();
          const watchDtls = () => {
            const transports = [...pc.getSenders(), ...pc.getReceivers()].map((end) => end.transport);
            if (pc.sctp) transports.push(pc.sctp.transport);
            for (const transport of transports) {
              if (!transport || watched.has(transport)) continue;
              watched.add(transport);
              states.push({ pc: index, dtls: transport.state });
              transport.addEventListener('statechange', () => states.push({ pc: index, dtls: transport.state }));
            }
          };
          const invert = (value: string) => value.split(':')
            .map((byte) => (255 - parseInt(byte, 16)).toString(16).padStart(2, '0').toUpperCase()).join(':');
          const apply = pc.setRemoteDescription.bind(pc);
          pc.setRemoteDescription = async (description: RTCSessionDescriptionInit) => {
            const sdp = description.sdp?.replace(/^(a=fingerprint:\S+ )([0-9A-Fa-f:]+)/gm,
              (_line, prefix: string, value: string) => `${prefix}${invert(value)}`);
            await apply(sdp === undefined ? description : { type: description.type, sdp });
            watchDtls();
          };
        }
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
  }, options.tamperRemoteFingerprint === true);
  await page.addScriptTag({ path: '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js' });
  try { await page.evaluate(async ({ url, token, relayOnly }) => {
    const w = window as Window & { LivekitClient?: { Room: new (options?: { rtcConfig: { iceTransportPolicy: string } }) => {
      connect(url: string, token: string): Promise<void>; localParticipant: {
        publishTrack(track: MediaStreamTrack): Promise<unknown> }; remoteParticipants: Map<string, unknown>;
        state: string; disconnect(): Promise<void> } }; fluxRoom?: unknown };
    const sdk = w.LivekitClient;
    if (!sdk) throw new Error('Pinned LiveKit browser SDK missing');
    const room = new sdk.Room(relayOnly ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined);
    w.fluxRoom = room;
    await room.connect(url, token);
  }, { url: media.mediaUrl, token: media.token, relayOnly }); }
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
    throw new Error(`Browser ICE connection failed: ${String(error)}; ${JSON.stringify({
      ...diagnosis, signaling, origin: new URL(page.url()).origin,
      hasSessionCookie: (await page.context().cookies()).some((cookie) => cookie.name.includes('session_token')),
    })}`);
  }
}

export async function selectedCandidates(page: Page): Promise<CandidateEvidence[]> {
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
