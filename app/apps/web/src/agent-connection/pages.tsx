import { useState, type ReactNode } from 'react';
import { redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { AgentConnection } from '@flux/contracts';
import { getMe } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import { SettingsBack } from '../app/SettingsBack';
import { signInPath } from '../auth/logic';
import { Button, Icon, Kreska, agentHue } from '../ui';
import { decideAgentConsent, followOAuthRedirect, getConsentContext, listAgentConnections, revokeAgentConnection, type ConsentContext } from './api';
import { ClientGuide } from './ClientGuide';
import { MayDoChoice } from './MayDoChoice';
import './connection.css';

interface ConnectionData { connections: AgentConnection[] }

function queryFrom(request: Request) { return new URL(request.url).search.slice(1); }

async function requirePerson(request: Request) {
  const me = await getMe(request.signal);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(signInPath(`${url.pathname}${url.search}`));
  }
  return me;
}

/** Settings → AI → your agent app: where a person sees their connected clients and sets what each may do (#763 AG-2, #859). */
export const CONNECT_AGENT_SETTINGS = '/settings/agents/connect';

/**
 * `/connect-agent` is only a way to the Settings page. A client's sign-in no longer passes through it: connecting is one decision on
 * the consent page, so nothing is chosen first (#859).
 */
export function agentConnectionEntryLoader(): never { throw redirect(CONNECT_AGENT_SETTINGS); }

export async function agentConnectionLoader({ request }: LoaderFunctionArgs): Promise<ConnectionData> {
  await requirePerson(request);
  // The owner's assistant has its own screen; it is never one of the local clients listed here.
  return { connections: (await listAgentConnections(request.signal)).filter((connection) => connection.computeSource !== 'owner_assistant') };
}

export async function agentConsentLoader({ request }: LoaderFunctionArgs): Promise<{ context: ConsentContext; oauthQuery: string }> {
  await requirePerson(request);
  const oauthQuery = queryFrom(request);
  if (!oauthQuery) throw new Response('The authorization request is missing. Start again in your agent client.', { status: 400 });
  const context = await getConsentContext(oauthQuery, request.signal);
  return { context, oauthQuery };
}

function describeError(error: unknown) {
  if (error instanceof NetworkError) return 'Flux cannot be reached. Check your connection and try again.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session ended. Sign in, then start the connection again.';
    if (error.status === 403 || error.status === 404) return 'This connection is no longer available to you.';
    if (error.status === 400 || error.status === 409) return 'This authorization request is no longer valid. Start again in your agent client.';
  }
  return error instanceof Error && error.message.startsWith('Flux did not return') ? error.message : 'Something went wrong. Try again.';
}

function Head({ eyebrow, title, children }: { eyebrow?: string; title: string; children: ReactNode }) {
  return <header className="connection__head">
    {/* Agents are Kreska (F-026 §3), not the assistant's spark (#763 WF-5). */}
    {eyebrow ? <span className="connection__eyebrow"><Kreska size={16} /> {eyebrow}</span> : null}
    <h1>{title}</h1>
    <p>{children}</p>
  </header>;
}

/** The person's own Claude Code or Codex (F-026 §7): each connected one with its "What it may do" and Disconnect, then how to connect another (#1363). */
export function AgentConnectionPage() {
  const { connections } = useLoaderData() as ConnectionData;
  const [items, setItems] = useState(connections.filter((connection) => !connection.revokedAt));
  const [ended, setEnded] = useState(connections.filter((connection) => connection.revokedAt));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect(connectionId: string) {
    setBusy(true); setError(null);
    try {
      await revokeAgentConnection(connectionId);
      const gone = items.find((item) => item.id === connectionId);
      if (gone) setEnded((current) => [{ ...gone, revokedAt: new Date().toISOString() }, ...current]);
      setItems((current) => current.filter((item) => item.id !== connectionId));
      setConfirming(null);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  return <section className="connection" aria-label="Claude Code, Codex or another app">
    <Head title="Claude Code, Codex or another app on your computer">
      For code on your computer. It signs in once, with one click, and then acts as you with the same rules as your agents: it sees and changes what you can, only as far as
      “What it may do” allows. Deleting and other people’s things always wait for your OK.
    </Head>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    {items.length ? <ul className="connection__list" aria-label="Connected clients">{items.map((connection) => <li className="connection__saved sset-card" key={connection.id}>
      <div className="connection__row">
        <Kreska size={22} hue={agentHue(connection.agentId)} />
        <div className="connection__summary">
          <strong>{connection.name}</strong>
          <span className="connection__meta">For code on your computer. Same rules as your agents.</span>
        </div>
      </div>
      <div className="connection__may-do">
        <p className="connection__may-do-label" id={`may-do-${connection.id}`}>What it may do</p>
        <MayDoChoice connectionId={connection.id} initial={connection.mayDo} labelledBy={`may-do-${connection.id}`} />
      </div>
      {confirming === connection.id
        ? <div className="connection__revoke"><span>Disconnect now? Its access stops at once and what it had waiting is dropped.</span>
          <Button variant="secondary" busy={busy} onClick={() => { void disconnect(connection.id); }}>Disconnect</Button>
          <Button variant="link" onClick={() => setConfirming(null)}>Cancel</Button></div>
        : <Button variant="link" onClick={() => setConfirming(connection.id)}>Disconnect</Button>}
    </li>)}</ul> : <p className="connection__help">Nothing is connected yet. Add Flux to the app you use below; it asks you once.</p>}
    {ended.length ? <details className="connection__history">
      <summary>Disconnected ({ended.length})</summary>
      <p>These can’t sign in again. Connecting the app again makes a new connection; what it did stays where it was.</p>
      <ul>{ended.map((connection) => <li key={connection.id}><strong>{connection.name}</strong><span>Disconnected</span></li>)}</ul>
    </details> : null}
    <ClientGuide origin={window.location.origin} />
  </section>;
}

/** The same page inside Settings, with the way back first on the left as on every Settings sub-page (Spokój). */
export function AgentConnectionSettings() {
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in connection-settings">
        <SettingsBack />
        <AgentConnectionPage />
      </div>
    </div>
  );
}

/** Where an approved request goes (#287): the redirect host, the client_id host and a warning off this computer. */
function ConsentDestination({ context }: { context: ConsentContext }) {
  const { redirect, clientIdHost } = context;
  return <section className="connection__destination" aria-labelledby="consent-destination">
    <h2 id="consent-destination">Where access goes</h2>
    <dl>
      <div><dt>Sends access to</dt><dd className="connection__host">{redirect.host}</dd></div>
      <div><dt>Client details from</dt>{clientIdHost
        ? <dd className="connection__host">{clientIdHost}</dd>
        : <dd>Registered on this Flux server</dd>}</div>
    </dl>
    {redirect.kind === 'loopback'
      ? <p>This address is on your own computer, where your agent client runs.{clientIdHost
        ? <> Access goes to a program on this computer that names itself as the client at <strong>{clientIdHost}</strong>; Flux cannot check that claim.</>
        : null}</p>
      : <p className="connection__warning" role="note">
        <Icon name="alert" size={16} />
        {redirect.kind === 'app'
          ? <span><strong>This access goes to an app link.</strong> Flux will hand it to whichever app on this device opens that link. Allow only if you set up this client and trust that app.</span>
          : <span><strong>This address is not on your computer.</strong> Flux will send access to {redirect.host}, and whoever controls that address can use this connection. Allow only if you set up this client and trust that address.</span>}
      </p>}
  </section>;
}

export function AgentConsentPage() {
  const { context, oauthQuery } = useLoaderData() as { context: ConsentContext; oauthQuery: string };
  return <ConsentReview context={context} oauthQuery={oauthQuery} />;
}

/**
 * The whole sign-in (#859, F-036 LC-1): who asks, where access goes and what it will be, then Allow or Deny. Nothing else is chosen.
 * Allow makes the client's connection when it has none, with an agent of the person's own behind it; Deny makes nothing.
 */
function ConsentReview({ context, oauthQuery }: { context: ConsentContext; oauthQuery: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(accept: boolean) {
    setBusy(true); setError(null);
    try { followOAuthRedirect(await decideAgentConsent(accept, oauthQuery)); }
    catch (cause) { setError(describeError(cause)); setBusy(false); }
  }
  return <section className="connection connection--consent" aria-label="Agent access consent">
    <Head eyebrow="Agent connection" title={`Connect ${context.clientName} to Flux`}>
      <strong>{context.clientName}</strong> {context.connectionName
        ? <>is already connected as <strong>{context.connectionName}</strong>. Allow signs it in again.</>
        : <>wants to sign in. It will act as you.</>}
    </Head>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    <ConsentDestination context={context} />
    <ul className="connection__scopes" aria-label="What it will be">
      <li><Icon name="check" size={15} /><span><strong>Acts with your rights</strong><small>It sees and changes only what you can, in the spaces where AI is on, and no more.</small></span></li>
      <li><Icon name="check" size={15} /><span><strong>Does what “What it may do” says</strong><small>It starts at “Do it and tell me”. You can set Only read or Ask me first any time in Settings › AI.</small></span></li>
      <li><Icon name="check" size={15} /><span><strong>Deleting and other people’s things wait for your OK</strong><small>Whatever you choose. Only you, here, can approve.</small></span></li>
    </ul>
    <div className="connection__footer">
      <Button variant="primary" size="lg" busy={busy} onClick={() => { void decide(true); }}>Allow</Button>
      <Button size="lg" disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
    </div>
    <p className="connection__help">Your external client handles compute; Flux does not receive provider credentials or verify how the client is billed. You can disconnect it any time in Settings › AI.</p>
  </section>;
}
