import { createHash } from 'node:crypto';
import { ACCOUNT_LABEL, AUTH_METHOD, PLAN_LABEL, type ClientFacts, type RuntimeClient } from '@flux/runtime-protocol';

// A CLI's own status, reduced in the slot to display facts (F-022 "Sign-in as in a terminal", step 5):
// the method, the plan if reported, a masked account label and a digest of the account for the
// account-change notice. The address itself never leaves the slot, and nothing here reads a credential
// file: only the status command's own output, kept in memory and never logged.
//
// `claude auth status` prints JSON and exits 0 when signed in. Signed out, Claude Code 2.1.285 printed
// (2026-10-06, pinned binary, no account): {"loggedIn": false, "authMethod": "none", "apiProvider":
// "firstParty", …} with exit 1. The fields of a signed-in status are not documented; the names read
// below are the likely ones and are UNVERIFIED until the real-account check (T10). A field that is
// missing or does not match its pattern is left out, never guessed.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function pick(value: Json, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) current = isObject(current) ? current[key] : undefined;
    if (typeof current === 'string' && current.length > 0 && current.length <= 320) return current;
  }
  return null;
}

/** `a***@example.org`: the address's first character and its domain, or null for anything unusual. */
export function maskAccount(address: string): string | null {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  const first = trimmed[0]!;
  const domain = trimmed.slice(at + 1).toLowerCase();
  const label = `${/[A-Za-z0-9]/.test(first) ? first.toLowerCase() : '*'}***@${/^[a-z0-9.-]{1,70}$/.test(domain) ? domain : '*'}`;
  return ACCOUNT_LABEL.test(label) ? label : null;
}

export function accountDigest(address: string, organization: string | null): string {
  return createHash('sha256').update(`flux-runtime-account-v1\n${address.trim().toLowerCase()}\n${organization ?? ''}`).digest('hex');
}

/**
 * Signed in only when the status command exited 0 and, if it printed JSON, that JSON does not say
 * `loggedIn: false`. Facts come from the JSON when it is there.
 */
export function statusFacts(client: RuntimeClient, exitCode: number | null, stdout: string): { signedIn: boolean; facts: ClientFacts | null } {
  if (exitCode !== 0) return { signedIn: false, facts: null };
  if (client !== 'claude_code') return { signedIn: true, facts: null };
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { parsed = undefined; }
  if (!isObject(parsed)) return { signedIn: true, facts: { authMethod: 'unknown', plan: null, accountLabel: null, accountDigest: null } };
  if (parsed.loggedIn === false) return { signedIn: false, facts: null };
  const method = typeof parsed.authMethod === 'string' && AUTH_METHOD.test(parsed.authMethod) ? parsed.authMethod : 'unknown';
  if (method === 'none') return { signedIn: false, facts: null };
  const plan = pick(parsed, [['subscriptionType'], ['subscription'], ['plan'], ['oauthAccount', 'subscriptionType']]);
  const address = pick(parsed, [['email'], ['emailAddress'], ['account', 'email'], ['oauthAccount', 'emailAddress']]);
  const organization = pick(parsed, [['orgId'], ['organizationId'], ['orgUuid'], ['organizationUuid'], ['oauthAccount', 'organizationUuid']]);
  return {
    signedIn: true,
    facts: {
      authMethod: method,
      plan: plan && PLAN_LABEL.test(plan) ? plan : null,
      accountLabel: address ? maskAccount(address) : null,
      accountDigest: address ? accountDigest(address, organization) : null,
    },
  };
}
