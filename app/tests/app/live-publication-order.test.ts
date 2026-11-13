import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveMediaConnection } from '../../apps/web/src/live/media.js';

// Use the same ESM SDK class as media.ts, so its instanceof branch is real.
const sdkUrl = new URL('../../apps/web/node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url).href;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A connection with a screen, a camera and a microphone published, to a media server that takes a few milliseconds to answer each
 * publication and unpublication. `overlaps` counts the steps that began while another one was still waiting for its answer: LiveKit
 * negotiates each with the server, and overlapping ones left the server with a screen nobody sent and without the camera (#1339).
 */
async function connection(answerMs = 8) {
  const sdk = await import(sdkUrl) as { LocalVideoTrack: { prototype: object }; Track: { Source: Record<string, string> } };
  const events: string[] = [];
  let active = 0;
  let overlaps = 0;
  const published = new Map<string, { trackSid: string; source: string; track: { stop(): void } }>();
  const stopped: string[] = [];
  const step = async (name: string, ms: number) => {
    active += 1;
    if (active > 1) overlaps += 1;
    events.push(`${name}:start`);
    await wait(ms);
    events.push(`${name}:end`);
    active -= 1;
  };
  type Capture = { stop(): void; source: string };
  const media = (source: string): Capture => ({ stop() { stopped.push(source); }, source });
  const screenTrack = Object.create(sdk.LocalVideoTrack.prototype) as Capture;
  Object.defineProperties(screenTrack, {
    ...Object.fromEntries(Object.entries(media(sdk.Track.Source.ScreenShare!)).map(([key, value]) => [key, { value, writable: true }])),
    mediaStreamTrack: { value: { contentHint: '', applyConstraints: async () => { await wait(10); }, addEventListener: () => {} } },
  });
  const tracks: Record<string, Capture> = { screen: screenTrack, camera: media(sdk.Track.Source.Camera!), mic: media(sdk.Track.Source.Microphone!) };
  for (const [name, track] of Object.entries(tracks)) published.set(`sid-${name}`, { trackSid: `sid-${name}`, source: track.source, track });
  const publishes: { source: string; degradationPreference?: string }[] = [];
  const local = {
    identity: '',
    trackPublications: published,
    getTrackPublication: (source: string) => [...published.values()].find((publication) => publication.source === source),
    // As LiveKit does: the publication is gone at once, the answer from the server comes later.
    unpublishTrack: async (track: { stop(): void }, stop?: boolean) => {
      const entry = [...published.entries()].find(([, publication]) => publication.track === track);
      if (!entry) return undefined;
      published.delete(entry[0]);
      if (stop !== false) track.stop();
      await step(`unpublish ${entry[1].source}`, answerMs);
      return entry[1];
    },
    publishTrack: async (track: { source: string; stop(): void }, options: { degradationPreference?: string }) => {
      publishes.push({ source: track.source, degradationPreference: options.degradationPreference });
      await step(`publish ${track.source}`, 12);
      published.set(`sid-${track.source}-${publishes.length}`, { trackSid: `sid-${track.source}-${publishes.length}`, source: track.source, track });
    },
  };
  const connected = Object.assign(Object.create(LiveMediaConnection.prototype) as {
    setScreenMode: LiveMediaConnection['setScreenMode']; setDevice: LiveMediaConnection['setDevice']; disconnect: LiveMediaConnection['disconnect'];
    stopDevice(kind: string, status: { state: string; note: string | null }): Promise<unknown>; devices: Record<string, { state: string }>;
  }, {
    room: { localParticipant: local, disconnect: async () => { events.push('room disconnect'); } },
    devices: { mic: { state: 'on', note: null }, camera: { state: 'on', note: null }, screen: { state: 'on', note: null } },
    generation: { mic: 0, camera: 0, screen: 0 },
    pending: { mic: new Set(), camera: new Set(), screen: new Set() },
    connection: 'connected', leaving: false, republishing: 0, screenMode: 'text', screenSent: 'text', publications: Promise.resolve(),
    trackDiagnostics: { clear: () => {} }, audio: { detachMic: () => {} }, emit: () => {},
  });
  return { connected, events, published, publishes, stopped, overlaps: () => overlaps, tracks };
}

test('a screen published again, Stop sharing and the camera and microphone going off each wait for the one before', async () => {
  const { connected, events, published, overlaps, stopped } = await connection();
  const switched = connected.setScreenMode('motion');
  await wait(2);
  const stops = [
    connected.stopDevice('camera', { state: 'off', note: null }),
    connected.stopDevice('mic', { state: 'off', note: null }),
    wait(18).then(() => connected.stopDevice('screen', { state: 'off', note: null })),
  ];
  await Promise.all([switched, ...stops]);
  assert.equal(overlaps(), 0, `no two publication steps ran at once: ${events.join(', ')}`);
  assert.deepEqual([...published.keys()], [], 'nothing is left published once everything is stopped');
  assert.deepEqual(Object.values(connected.devices).map((device) => device.state), ['off', 'off', 'off']);
  assert.equal(stopped.length >= 3, true, 'every capture was stopped');
});

test('a mode chosen again before the screen has switched leaves it sent in the last one chosen', async () => {
  const back = await connection();
  await Promise.all([back.connected.setScreenMode('motion'), back.connected.setScreenMode('text')]);
  assert.equal(back.publishes.length, 0, 'changed and changed back: the screen is already sent as chosen last');
  const again = await connection();
  await Promise.all([again.connected.setScreenMode('motion'), again.connected.setScreenMode('text'), again.connected.setScreenMode('motion')]);
  assert.equal(again.publishes.length, 1, 'one republication for three choices');
  assert.equal(again.publishes[0]!.degradationPreference, 'maintain-framerate', 'in the mode chosen last (smooth motion)');
});

test('leaving does not wait behind a publication in progress: the captures stop and the room is left at once', async () => {
  const { connected, events, stopped } = await connection(80);
  const switched = connected.setScreenMode('motion');
  await wait(25);
  assert.equal(events.includes('unpublish screen_share:start'), true, 'the screen is being published again');
  await connected.disconnect();
  assert.deepEqual([...new Set(stopped)].sort(), ['camera', 'microphone'], 'the camera and the microphone were stopped at once');
  assert.equal(events.includes('unpublish screen_share:end'), false, 'the room was left while the publication was still waiting for its answer');
  assert.equal(events.includes('room disconnect'), true);
  // The screen being published again is stopped when its step ends, and is not published anew.
  await switched;
  assert.equal(stopped.includes('screen_share'), true, 'the screen capture stopped too');
  assert.equal(events.some((event) => event.startsWith('publish screen_share')), false, 'nothing was published after leaving');
});

test('a microphone turned off while the screen is being published again stops sending at once; its unpublication waits its turn', async () => {
  const { connected, events, stopped, overlaps } = await connection(80);
  const switched = connected.setScreenMode('motion');
  await wait(25);
  assert.equal(events.includes('unpublish screen_share:start'), true, 'the screen is being published again');
  const off = connected.stopDevice('mic', { state: 'off', note: null });
  assert.deepEqual(stopped, ['microphone'], 'the microphone capture stopped on the press');
  assert.equal(connected.devices.mic!.state, 'off');
  assert.equal(events.includes('unpublish microphone:start'), false, 'its unpublication waits for the screen step');
  await Promise.all([switched, off]);
  assert.equal(events.includes('unpublish microphone:end'), true);
  assert.equal(overlaps(), 0, events.join(', '));
});
