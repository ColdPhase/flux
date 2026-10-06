import { createHash, createSign, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

/**
 * A deterministic OpenID Connect provider for tests only (#113), run by scripts/check_oidc.sh
 * from the existing e2e image. Keycloak never issues a bad ID token, so this stand-in drives the
 * same authorization-code flow (discovery, JWKS, authorize with PKCE/state/nonce, token endpoint
 * with client authentication) and, per sign-in, corrupts exactly one property of the ID token:
 *
 *   valid           a correct token
 *   bad-nonce       the nonce differs from the one Flux sent to /authorize
 *   bad-signature   signed by another key under the published key id
 *   bad-issuer      `iss` names another issuer
 *   bad-audience    `aud` names another client
 *
 * The test chooses the mode and claims for the next sign-in with POST /__next and reads what the
 * token endpoint actually issued with GET /__issued. Never part of a deployment.
 */
export type MockMode = 'valid' | 'bad-nonce' | 'bad-signature' | 'bad-issuer' | 'bad-audience';
export interface MockIdentity { mode: MockMode; sub: string; email: string; name: string; emailVerified?: boolean }
export interface MockIssued { mode: MockMode; sub: string; email: string; nonceSent: boolean; claims: Record<string, unknown> }

const MODES: readonly MockMode[] = ['valid', 'bad-nonce', 'bad-signature', 'bad-issuer', 'bad-audience'];
const PORT = 9400;
const ISSUER = process.env.FLUX_OIDC_MOCK_ISSUER ?? `http://oidc-mock:${PORT}`;
const CLIENT_ID = 'flux';
const CLIENT_SECRET = readFileSync(process.env.FLUX_OIDC_CLIENT_SECRET_FILE ?? '/run/secrets/flux_oidc_client_secret', 'utf8').trim();
const PROVIDER_ID = `oidc-${createHash('sha256').update(ISSUER).digest('hex').slice(0, 12)}`;
const REDIRECT_URI = `${process.env.FLUX_PUBLIC_ORIGIN}/api/auth/callback/${PROVIDER_ID}`;
const KID = 'mock-signing-key';

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
// The forger's key: a valid RSA signature, but not by the key the JWKS publishes.
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });

let next: MockIdentity | null = null;
const codes = new Map<string, { identity: MockIdentity; nonce: string; challenge: string; redirectUri: string }>();
const issued: MockIssued[] = [];

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

function sign(claims: Record<string, unknown>, key: KeyObject) {
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

function idToken(identity: MockIdentity, nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: identity.mode === 'bad-issuer' ? 'http://attacker-idp:9400' : ISSUER,
    aud: identity.mode === 'bad-audience' ? 'another-client' : CLIENT_ID,
    sub: identity.sub,
    iat: now,
    exp: now + 300,
    nonce: identity.mode === 'bad-nonce' ? `${nonce}-replayed` : nonce,
    email: identity.email,
    email_verified: identity.emailVerified ?? true,
    name: identity.name,
  };
  return { claims, token: sign(claims, identity.mode === 'bad-signature' ? rogue.privateKey : signing.privateKey) };
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

async function body(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', ISSUER);
  try {
    if (url.pathname === '/health') return response.writeHead(200).end('ok');
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(response, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(response, 200, { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
    }
    if (url.pathname === '/__next' && request.method === 'POST') {
      const identity = JSON.parse(await body(request)) as MockIdentity;
      if (!MODES.includes(identity.mode) || !identity.sub || !identity.email || !identity.name) return json(response, 400, { error: 'mode, sub, email and name are required' });
      next = identity;
      return response.writeHead(204).end();
    }
    if (url.pathname === '/__issued') return json(response, 200, issued);
    if (url.pathname === '/authorize') {
      const query = url.searchParams;
      const problem = query.get('client_id') !== CLIENT_ID ? 'unknown client'
        : query.get('redirect_uri') !== REDIRECT_URI ? `unregistered redirect_uri ${query.get('redirect_uri')}`
          : query.get('response_type') !== 'code' ? 'only the code flow'
            : query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge') ? 'PKCE S256 is required'
              : !query.get('state') ? 'state is required'
                : !query.get('nonce') ? 'nonce is required'
                  : !(query.get('scope') ?? '').split(' ').includes('openid') ? 'scope openid is required'
                    : !next ? 'the test chose no identity (POST /__next)' : '';
      if (problem) return response.writeHead(400, { 'content-type': 'text/plain' }).end(problem);
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { identity: next!, nonce: query.get('nonce')!, challenge: query.get('code_challenge')!, redirectUri: REDIRECT_URI });
      next = null;
      const target = new URL(REDIRECT_URI);
      target.searchParams.set('code', code);
      target.searchParams.set('state', query.get('state')!);
      target.searchParams.set('iss', ISSUER);
      return response.writeHead(302, { location: target.toString() }).end();
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request));
      let clientId = form.get('client_id') ?? '';
      let secret = form.get('client_secret') ?? '';
      const basic = /^Basic (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
      if (basic) {
        const decoded = Buffer.from(basic, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      }
      if (clientId !== CLIENT_ID || !safeEqual(secret, CLIENT_SECRET)) return json(response, 401, { error: 'invalid_client' });
      const code = form.get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code);
      if (form.get('grant_type') !== 'authorization_code' || !grant || form.get('redirect_uri') !== grant.redirectUri) return json(response, 400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const { claims, token } = idToken(grant.identity, grant.nonce);
      issued.push({ mode: grant.identity.mode, sub: grant.identity.sub, email: grant.identity.email, nonceSent: !!grant.nonce, claims });
      return json(response, 200, { access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300, scope: 'openid email profile', id_token: token });
    }
    response.writeHead(404).end();
  } catch (error) {
    json(response, 500, { error: (error as Error).message });
  }
}).listen(PORT, '0.0.0.0');

console.log(`OIDC mock ${ISSUER} (provider ${PROVIDER_ID}) listening on :${PORT}`);
