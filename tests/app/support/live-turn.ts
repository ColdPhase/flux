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

export async function connect(page: Page, media: LiveJoinGrant, pageUrl?: string, relayOnly = false): Promise<void> {
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

