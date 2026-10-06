// Route and Compose-consistency assertions for the rendered k3s live-media chart (#63).
// Run by scripts/check_live_k3s.sh inside the pinned Node image:
//   node live_k3s_render.mjs <render.json> <compose-livekit.json> <example|operator> <render.yaml>
// render.json: the `helm template` objects as a JSON array, the ConfigMap's config.yaml parsed.
// compose-livekit.json: `services.livekit` of the Compose operator layers, LIVEKIT_CONFIG parsed.
// After checking the render, it re-checks mutated copies and fails unless each is refused.
import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';

const subnets = (ranges) => {
  const list = new BlockList();
  for (const [address, prefix] of ranges) list.addSubnet(address, prefix, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  return list;
};
const ipv = (address) => (isIP(address) === 6 ? 'ipv6' : 'ipv4');
const privateOrLoopback = subnets([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['127.0.0.0', 8], ['fc00::', 7], ['::1', 128]]);
const loopback = subnets([['127.0.0.0', 8], ['::1', 128]]);
const nonPublic = subnets([['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['::', 128], ['::1', 128],
  ['fc00::', 7], ['fe80::', 10]]);
const documentation = subnets([['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['2001:db8::', 32]]);
const WEBHOOK_PATH = '/api/v1/internal/livekit/webhook';
const MEDIA_PORTS = { 'rtc-tcp': [7881, 'TCP'], 'rtc-udp': [7882, 'UDP'], 'turn-udp': [3478, 'UDP'], 'turn-tls': [443, 'TCP'] };

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// yq reads YAML 1.2, where `0600` is decimal 600; Kubernetes reads the chart's YAML 1.1 `0600`
// as octal (384). Accept 384, or 600 only when the rendered text spells it `0600`.
const OWNER_ONLY_KEYS = /- name: keys-volume\n\s+secret:\n\s+secretName: \S+\n\s+defaultMode: 0600\n/;

/** Returns the names of failed assertions; empty when the render keeps the agreed route. */
export function check(objects, compose, mode, renderText) {
  const failures = [];
  const expect = (name, ok) => { if (!ok) failures.push(name); };
  const kinds = objects.map((object) => object?.kind).sort();
  expect('only a ConfigMap, a Service and a Deployment are rendered', same(kinds, ['ConfigMap', 'Deployment', 'Service']));
  expect('no Ingress, Secret or load balancer object', !objects.some((object) =>
    /Ingress|Secret|Gateway|Route/.test(object?.kind ?? '') ||
    (object?.kind === 'Service' && (['LoadBalancer', 'NodePort'].includes(object.spec?.type) || object.spec?.externalIPs))));

  const configMap = objects.find((object) => object?.kind === 'ConfigMap');
  const service = objects.find((object) => object?.kind === 'Service');
  const deployment = objects.find((object) => object?.kind === 'Deployment');
  const config = configMap?.data?.['config.yaml'] ?? {};
  const rtc = config.rtc ?? {};
  const turn = config.turn ?? {};

  expect('Service `livekit` is ClusterIP with signaling 7880', service?.metadata?.name === 'livekit' &&
    (service.spec?.type ?? 'ClusterIP') === 'ClusterIP' &&
    (service.spec?.ports ?? []).some((port) => port.port === 7880 && port.targetPort === 'http'));

  const pod = deployment?.spec?.template?.spec ?? {};
  const container = pod.containers?.length === 1 ? pod.containers[0] : undefined;
  expect('one replica', deployment?.spec?.replicas === 1);
  expect('Recreate strategy', deployment?.spec?.strategy?.type === 'Recreate');
  expect('host network with cluster DNS', pod.hostNetwork === true && pod.dnsPolicy === 'ClusterFirstWithHostNet');
  expect('scheduled on a selected media node', Object.keys(pod.nodeSelector ?? {}).length > 0);
  expect('graceful drain period', (pod.terminationGracePeriodSeconds ?? 0) >= 60);
  expect('one container', Boolean(container));
  expect('image equals the Compose image digest', typeof container?.image === 'string' &&
    /@sha256:[0-9a-f]{64}$/.test(container.image) && container.image === compose?.image);
  const ports = Object.fromEntries((container?.ports ?? []).map((port) => [port.name, port]));
  for (const [name, [number, protocol]] of Object.entries(MEDIA_PORTS))
    expect(`media port ${name} ${number}/${protocol} on the host`, ports[name]?.containerPort === number &&
      ports[name]?.hostPort === number && ports[name]?.protocol === protocol);
  expect('signaling port 7880 declared without a host port', ports.http?.containerPort === 7880 && ports.http?.hostPort === undefined);
  const env = Object.fromEntries((container?.env ?? []).map((variable) => [variable.name, variable]));
  expect('config from the ConfigMap', env.LIVEKIT_CONFIG?.valueFrom?.configMapKeyRef?.name === configMap?.metadata?.name);
  const volumes = Object.fromEntries((pod.volumes ?? []).map((volume) => [volume.name, volume]));
  const keysMode = volumes['keys-volume']?.secret?.defaultMode;
  expect('API keys from an existing Secret at mode 0600', Boolean(volumes['keys-volume']?.secret?.secretName) &&
    (keysMode === 0o600 || (keysMode === 600 && OWNER_ONLY_KEYS.test(renderText))));
  expect('TURN certificate from the configured TLS Secret', Boolean(turn.secretName) &&
    volumes.lkturncert?.secret?.secretName === turn.secretName);

  expect('no API secret in the ConfigMap', Object.keys(config.keys ?? {}).length === 0 && config.key_file === 'keys.yaml');
  expect('signaling 7880 and metrics 6789', config.port === 7880 && config.prometheus_port === 6789);
  const binds = Array.isArray(config.bind_addresses) ? config.bind_addresses : [];
  expect('signaling binds loopback and private addresses only', binds.length >= 2 &&
    binds.some((address) => isIP(address) && loopback.check(address, ipv(address))) &&
    binds.every((address) => isIP(address) && privateOrLoopback.check(address, ipv(address))));
  expect('ICE TCP 7881 and UDP mux 7882 without a port range', rtc.tcp_port === 7881 && rtc.udp_port === 7882 &&
    rtc.port_range_start === 0 && rtc.port_range_end === 0);
  expect('public node_ip without external IP discovery', rtc.use_external_ip === false && isIP(rtc.node_ip ?? '') > 0 &&
    !nonPublic.check(rtc.node_ip, ipv(rtc.node_ip)) && !binds.includes(rtc.node_ip));
  expect('TURN UDP 3478 and TLS 443 terminated by LiveKit', turn.enabled === true && turn.udp_port === 3478 &&
    turn.tls_port === 443 && !turn.external_tls && Boolean(turn.domain));
  expect('STUN through the TURN name', same(rtc.stun_servers, [`${turn.domain}:3478`]));
  expect('TURN on all node addresses', turn.bind_addresses === undefined);
  expect('no private TURN peers allowed', turn.allow_restricted_peer_cidrs === undefined);
  expect('single node without Redis', Object.keys(config.redis ?? {}).length === 0);
  const hooks = config.webhook?.urls ?? [];
  expect('one signed webhook to the Flux API', Boolean(config.webhook?.api_key) && hooks.length === 1 &&
    new URL(hooks[0]).pathname === WEBHOOK_PATH);

  const composed = compose?.environment?.LIVEKIT_CONFIG ?? {};
  expect('Compose and k3s share room limits', Boolean(composed.room) && same(config.room, composed.room) &&
    config.room?.auto_create === false);
  expect('Compose and k3s share signaling and metrics ports',
    composed.port === config.port && composed.prometheus_port === config.prometheus_port);
  expect('Compose and k3s share ICE ports', composed.rtc?.tcp_port === rtc.tcp_port &&
    composed.rtc?.udp_port === rtc.udp_port && composed.rtc?.use_external_ip === rtc.use_external_ip);
  expect('Compose and k3s share TURN ports', composed.turn?.enabled === turn.enabled &&
    composed.turn?.udp_port === turn.udp_port && composed.turn?.tls_port === turn.tls_port);
  expect('Compose and k3s use the same webhook path', (composed.webhook?.urls ?? []).length === 1 &&
    new URL(composed.webhook.urls[0]).pathname === WEBHOOK_PATH);
  expect('Compose operator layers allow no private TURN peers', composed.turn?.allow_restricted_peer_cidrs === undefined);

  if (mode === 'operator') {
    const hosts = [rtc.node_ip, ...binds, turn.domain, ...hooks.map((url) => new URL(url).hostname)];
    expect('no documentation address or .example name left in the site values', hosts.every((host) =>
      typeof host === 'string' && !/(^|\.)example$/i.test(host) &&
      !(isIP(host) && documentation.check(host, ipv(host)))));
    // Placeholders of livekit-site.example.yaml that would otherwise deploy silently.
    expect('no example webhook key ID or node label left in the site values',
      config.webhook?.api_key !== 'flux-livekit-key-id' &&
      Object.keys(pod.nodeSelector ?? {}).every((label) => !/\.example\//i.test(label)));
  }
  return failures;
}

const mutations = {
  'without host networking': (r) => { r.deployment.spec.template.spec.hostNetwork = false; },
  'with a rolling update': (r) => { r.deployment.spec.strategy = { type: 'RollingUpdate' }; },
  'with a LoadBalancer Service': (r) => { r.service.spec.type = 'LoadBalancer'; },
  'with an Ingress': (r) => { r.objects.push({ kind: 'Ingress', metadata: { name: 'livekit' } }); },
  'with the chart port range': (r) => { r.config.rtc.port_range_start = 50000; r.config.rtc.port_range_end = 60000; },
  'with signaling on every address': (r) => { r.config.bind_addresses.push('0.0.0.0'); },
  'with a public signaling address': (r) => { r.config.bind_addresses[0] = r.config.rtc.node_ip; },
  'with a private node_ip': (r) => { r.config.rtc.node_ip = '10.1.2.3'; },
  'with inline API keys': (r) => { r.config.keys = { key: 'secret' }; },
  'with private TURN peers': (r) => { r.config.turn.allow_restricted_peer_cidrs = ['172.16.0.0/12']; },
  'with TURN bound to one address': (r) => { r.config.turn.bind_addresses = [r.config.rtc.node_ip]; },
  'with TURN/TLS off 443': (r) => { r.config.turn.tls_port = 5349; },
  'with another image': (r) => { r.deployment.spec.template.spec.containers[0].image = 'livekit/livekit-server:v1.9.0'; },
  'with another room limit': (r) => { r.config.room.max_participants = 100; },
  'with a readable key Secret': (r) => { r.deployment.spec.template.spec.volumes.find((v) => v.name === 'keys-volume').secret.defaultMode = 0o644; },
  'without the webhook': (r) => { delete r.config.webhook; },
  'with Compose TURN/TLS elsewhere': (r) => { r.compose.environment.LIVEKIT_CONFIG.turn.tls_port = 5349; },
};

function mutated(objects, compose, mutate) {
  const copy = structuredClone(objects);
  const r = { objects: copy, compose: structuredClone(compose),
    deployment: copy.find((object) => object.kind === 'Deployment'),
    service: copy.find((object) => object.kind === 'Service') };
  r.config = copy.find((object) => object.kind === 'ConfigMap').data['config.yaml'];
  mutate(r);
  return [r.objects, r.compose];
}

const [renderPath, composePath, mode, renderYamlPath] = process.argv.slice(2);
if (!renderPath || !composePath || !['example', 'operator'].includes(mode ?? '') || !renderYamlPath) {
  console.error('usage: node live_k3s_render.mjs <render.json> <compose-livekit.json> <example|operator> <render.yaml>');
  process.exit(2);
}
const objects = JSON.parse(readFileSync(renderPath, 'utf8')).filter(Boolean);
const compose = JSON.parse(readFileSync(composePath, 'utf8'));
const renderText = readFileSync(renderYamlPath, 'utf8');
const failures = check(objects, compose, mode, renderText);
for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length) process.exit(1);
console.log(`Route assertions passed (${mode} site values).`);

// Negative controls: each mutation of the passing render must be refused.
const missed = Object.entries(mutations).filter(([, mutate]) => !check(...mutated(objects, compose, mutate), mode, renderText).length);
for (const [name] of missed) console.error(`FAIL the assertions accept a render ${name}`);
if (missed.length) process.exit(1);
console.log(`Negative controls refused: ${Object.keys(mutations).length}/${Object.keys(mutations).length} mutated renders.`);
