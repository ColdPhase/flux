/**
 * TURN URLs without a transport query (#63).
 *
 * LiveKit's join response names its embedded TURN as `turn:<host>:3478?transport=udp` and
 * `turns:<host>:443?transport=tcp`. WebKit 26.5 (Playwright's build, observed 2026-10-30 in the
 * simulated public host) refuses any query in a TURN URL with "SyntaxError: Invalid TURN URL query
 * string", so the peer connection is never created and the person cannot join. RFC 7065 §3 gives
 * `turn:` UDP and `turns:` TCP as their default transports, so dropping exactly those two queries
 * names the same server and transport in every browser. Any other query is left as it is.
 */
const DEFAULT_TRANSPORT = /^(turns?):([^?]+)\?transport=(udp|tcp)$/i;

export function withoutDefaultTransport(url: string): string {
  const match = DEFAULT_TRANSPORT.exec(url.trim());
  if (!match) return url;
  const [, scheme, rest, transport] = match;
  const isDefault = scheme!.toLowerCase() === 'turn' ? transport!.toLowerCase() === 'udp' : transport!.toLowerCase() === 'tcp';
  return isDefault ? `${scheme}:${rest}` : url;
}

export function normalizeIceServers(config?: RTCConfiguration): RTCConfiguration | undefined {
  if (!config?.iceServers) return config;
  return {
    ...config,
    iceServers: config.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? server.urls.map(withoutDefaultTransport) : withoutDefaultTransport(server.urls),
    })),
  };
}

const INSTALLED = Symbol.for('flux.iceServersNormalized');

/** Replaces the page's RTCPeerConnection once with one that normalizes its ICE server URLs. */
export function installIceServerNormalizer(scope: { RTCPeerConnection?: typeof RTCPeerConnection } = globalThis): void {
  const Native = scope.RTCPeerConnection as (typeof RTCPeerConnection & { [INSTALLED]?: true }) | undefined;
  if (!Native || Native[INSTALLED]) return;
  class Normalized extends Native {
    constructor(config?: RTCConfiguration) {
      super(normalizeIceServers(config));
    }

    override setConfiguration(config?: RTCConfiguration): void {
      super.setConfiguration(normalizeIceServers(config));
    }
  }
  Object.defineProperty(Normalized, INSTALLED, { value: true });
  scope.RTCPeerConnection = Normalized;
}
