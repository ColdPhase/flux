// F-030 AC-10 fixture for scripts/check_backup.sh (#655), run inside a test deployment's API container (the fixture
// token and FLUX_TEST_FAILURE_INJECTION=true, as encrypted-workspace creation is fixture-only until S3).
//   seed      creates the encrypted space "Vault club" with password one and a project named by a canary, and a plain
//             project named by a control canary in the demo workspace; prints `FLUX_ENCRYPTION {json}`.
//   rekey     (after the backup) changes the unlock password to password two.
//   restored  (after the restore) checks that the space is locked (423), that password two does not open it, that
//             password one does, and that the project then reads back by its canary name.
const api = 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const mode = process.env.FLUX_FIXTURE_MODE;
const fixtureToken = process.env.FLUX_FIXTURE_TOKEN;
const owner = { email: 'ada@demo.flux.test', password: process.env.FLUX_DEMO_OWNER_PASSWORD };
if (!origin || !owner.password || !fixtureToken) throw new Error('FLUX_PUBLIC_ORIGIN, FLUX_FIXTURE_TOKEN and the demo owner password are required');
const state = process.env.FLUX_FIXTURE_STATE ? JSON.parse(process.env.FLUX_FIXTURE_STATE) : null;

const cookies = new Map();
async function call(method, path, body, extra = {}) {
  const headers = { origin, ...extra };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, api), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';'); const index = pair.indexOf('=');
    const value = pair.slice(index + 1).trim();
    if (value) cookies.set(pair.slice(0, index).trim(), value); else cookies.delete(pair.slice(0, index).trim());
  }
  const text = await response.text();
  return { status: response.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function expect(method, path, body, status, extra = {}) {
  const response = await call(method, path, body, extra);
  if (!status.includes(response.status)) throw new Error(`${method} ${path} answered ${response.status}: ${response.text.slice(0, 300)}`);
  return response.json;
}
const key = () => ({ 'idempotency-key': crypto.randomUUID() });

await expect('POST', '/api/auth/sign-in/email', { email: owner.email, password: owner.password }, [200]);

if (mode === 'seed') {
  const one = `vault one ${crypto.randomUUID()}`;
  const created = await expect('POST', '/api/v1/encrypted-workspaces', { name: 'Vault club', creationId: crypto.randomUUID(), password: one }, [201],
    { authorization: `Bearer ${fixtureToken}` });
  const canary = `VAULTCANARY${crypto.randomUUID().replaceAll('-', '')}`;
  const control = `PLAINCONTROL${crypto.randomUUID().replaceAll('-', '')}`;
  const project = await expect('POST', `/api/v1/workspaces/${created.workspace.id}/projects`, { name: canary, visibility: 'workspace' }, [201], key());
  const workspaces = await expect('GET', '/api/v1/workspaces', undefined, [200]);
  const plain = (workspaces.items ?? workspaces).find((workspace) => !workspace.encrypted && workspace.id !== created.workspace.id);
  await expect('POST', `/api/v1/workspaces/${plain.id}/projects`, { name: control, visibility: 'workspace' }, [201], key());
  console.log(`FLUX_ENCRYPTION ${JSON.stringify({ workspaceId: created.workspace.id, projectId: project.id, one, two: `vault two ${crypto.randomUUID()}`, canary, control })}`);
} else if (mode === 'rekey') {
  await expect('PUT', `/api/v1/workspaces/${state.workspaceId}/unlock-password`, { currentPassword: state.one, newPassword: state.two }, [200, 204]);
  // The new password opens it now, before the restore.
  await expect('POST', `/api/v1/workspaces/${state.workspaceId}/lock`, undefined, [200]);
  await expect('POST', `/api/v1/workspaces/${state.workspaceId}/unlock`, { password: state.two }, [200]);
  console.log('FLUX_ENCRYPTION rekeyed');
} else if (mode === 'restored') {
  const locked = await call('GET', `/api/v1/workspaces/${state.workspaceId}/projects`);
  if (locked.status !== 423) throw new Error(`the restored space is not locked: ${locked.status} ${locked.text.slice(0, 200)}`);
  if (locked.text.includes(state.canary)) throw new Error('the locked answer carries the canary');
  const later = await call('POST', `/api/v1/workspaces/${state.workspaceId}/unlock`, { password: state.two });
  if (later.status === 200) throw new Error('a password set after the backup opened the restored space');
  await expect('POST', `/api/v1/workspaces/${state.workspaceId}/unlock`, { password: state.one }, [200]);
  const projects = await expect('GET', `/api/v1/workspaces/${state.workspaceId}/projects`, undefined, [200]);
  if (!JSON.stringify(projects).includes(state.canary)) throw new Error('the unlocked space does not read back its project');
  console.log(`FLUX_ENCRYPTION restored: locked (423), password two refused (${later.status}), password one opened it, the project reads back`);
} else throw new Error(`unknown mode ${mode}`);
