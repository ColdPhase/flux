import assert from 'node:assert/strict';
import type { Draft, Project, Workspace, WorkspaceRole } from '@flux/contracts';
import { Browser, register, signIn, uniqueEmail, type ClientResponse } from './http.js';

export const password = 'correct horse battery staple';

export interface Person {
  id: string;
  email: string;
  browser: Browser;
}

export function expectStatus(response: ClientResponse, status: number, message?: string) {
  assert.equal(response.status, status, `${message ?? 'status'}: ${response.text}`);
  return response.json;
}

export async function person(label: string): Promise<Person> {
  const email = uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const { browser } = await register(email, password, label);
  const me = await browser.request('GET', '/api/v1/me');
  assert.equal(me.status, 200);
  return { id: (me.json as { user: { id: string } }).user.id, email, browser };
}

/** A second, independent session of the same person. */
export async function secondSession(someone: Person): Promise<{ browser: Browser; sessionId: string }> {
  const { browser, response } = await signIn(someone.email, password);
  assert.equal(response.status, 200);
  const me = await browser.request('GET', '/api/v1/me');
  return { browser, sessionId: (me.json as { session: { id: string } }).session.id };
}

export async function workspace(owner: Person, name: string): Promise<Workspace> {
  return expectStatus(await owner.browser.request('POST', '/api/v1/workspaces', { body: { name } }), 201) as Workspace;
}

export async function addMember(actor: Person, workspaceId: string, member: Person, role: WorkspaceRole) {
  expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/members`, { body: { email: member.email, role } }), 201);
}

export async function removeMember(actor: Person, workspaceId: string, member: Person) {
  expectStatus(await actor.browser.request('DELETE', `/api/v1/workspaces/${workspaceId}/members/${member.id}`), 204);
}

export async function project(actor: Person, workspaceId: string, name: string, visibility: 'workspace' | 'restricted'): Promise<Project> {
  return expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name, visibility } }), 201) as Project;
}

export async function grant(actor: Person, projectId: string, grantee: Person, role: 'contributor' | 'viewer' | 'denied') {
  expectStatus(await actor.browser.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'human', id: grantee.id }, role } }), 201);
}

export async function draft(actor: Person, workspaceId: string, title: string, options: { projectId?: string; body?: string } = {}): Promise<Draft> {
  return expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/drafts`, { body: { title, ...options } }), 201) as Draft;
}

export async function share(actor: Person, item: Draft, scope: 'private' | 'project' | 'workspace', projectId?: string): Promise<Draft> {
  const response = await actor.browser.request('POST', `/api/v1/drafts/${item.id}/share`, {
    body: projectId ? { scope, projectId } : { scope },
    headers: { 'if-match': `"${item.version}"` },
  });
  return expectStatus(response, 200, `share ${scope}`) as Draft;
}
