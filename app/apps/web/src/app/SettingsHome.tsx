import { getCapabilities, getLinkState, startLink, startSso } from '../api/auth';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Form, Link, Outlet, useLocation, useNavigation, useSearchParams } from 'react-router';
import { type AgentConnection, type BackgroundComputeConnection, type PersonalAssistantStatus, type IdentityCapabilities } from '@flux/contracts';
import { listAgentConnections } from '../agent-connection/api';
import { getAssistantStatus } from '../assistant/api';
import { listBackgroundConnections } from '../ai/api';
import { SERVER_AI_OFF_LINE } from '../assistant/format';
import { AgentsList } from '../my-agents/AgentsList';
import { Avatar, Button, Icon, Kreska, MEDIA, Spinner, setReduceMotion, useMediaQuery, useReduceMotion } from '../ui';
import { ConnectAi } from '../ai/ConnectAi';
import { ClientRows } from '../agent-connection/ClientRows';
import { WorkspacePeople } from '../people/WorkspacePeople';
import { AccountEditing, LastActiveSwitch } from './AccountEditing';
import '../agent-connection/connection.css';
import { useShellData } from './data';
import { setSmallMoments, useSmallMoments } from './smallMoments';
import { setTextSize, useTextSize, type TextSize } from './textSize';
import { setTheme, useTheme, type ThemeChoice } from './theme';
import './reading.css';
import './settings.css';
import { SwitchRow } from '../ui/SwitchRow';

// Settings (F-026, #350; Spokój #513): one calm place with Account, Appearance, Notifications, AI, Company (F-037,
// #874) and Keyboard shortcuts, in that order on every device. On the computer the section list sits beside the
// page; on the phone Settings is that list (the account card, then the sections) and each section is a page.
// Keyboard shortcuts appear only where there is a keyboard, so not on touch-only phones and tablets.

const SECTIONS: { to: string; label: string; match: RegExp }[] = [
  { to: '/settings/account', label: 'Account', match: /^\/settings\/account$/ },
  { to: '/settings', label: 'Appearance', match: /^\/settings(\/appearance)?$/ },
  { to: '/settings/notifications', label: 'Notifications', match: /^\/settings\/notifications/ },
  { to: '/settings/agents', label: 'AI', match: /^\/settings\/(agents|assistant|background-compute|ai-connections)/ },
  // The company's name and people have one stable place (F-037, #763 PE-1): read-only for members and guests.
  { to: '/settings/company', label: 'Company', match: /^\/settings\/company/ },
  { to: '/settings/shortcuts', label: 'Shortcuts', match: /^\/settings\/shortcuts$/ },
];

/** A guest has no agents and no AI (F-036 AG-2), so Settings shows them no AI section. */
const isGuest = (workspace: { role?: string | null } | null | undefined) => workspace?.role === 'guest';

/** The section list beside every Settings page on the computer; the phone leads from the Settings page instead. */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const { workspace } = useShellData();
  const phone = useMediaQuery(MEDIA.phone);
  // A touch-only tablet has no keyboard to use shortcuts with (AC-1).
  const touch = useMediaQuery(MEDIA.touch);
  return (
    <div className="sset">
      {phone ? null : (
        <nav className="sset__nav" aria-label="Settings sections">
          {SECTIONS.filter((section) => (!touch || section.to !== '/settings/shortcuts') && (section.to !== '/settings/agents' || !isGuest(workspace))).map((section) => (
            <Link key={section.to} to={section.to} className="sset__link" aria-current={section.match.test(pathname) ? 'page' : undefined}>
              {section.label}
            </Link>
          ))}
        </nav>
      )}
      <div className="sset__page"><Outlet /></div>
    </div>
  );
}

export { SwitchRow };

/** A row that opens another page: an optional icon, a title, a line of detail and a chevron or "Manage". */
function LinkRow({ to, title, detail, icon, action }: { to: string; title: ReactNode; detail?: ReactNode; icon?: ReactNode; action?: string }) {
  return (
    <li>
      <Link to={to} className="sset-row sset-row--link">
        {icon ? <span className="sset-row__ic" aria-hidden="true">{icon}</span> : null}
        <span className="sset-row__b"><span className="sset-row__t">{title}</span>{detail ? <span className="sset-row__s">{detail}</span> : null}</span>
        {action ? <span className="sset-row__go"><span className="sset-row__go-label">{action}</span><Icon name="chevron-right" size={12} /></span> : <Icon name="chevron-right" size={14} className="sset-row__go" />}
      </Link>
    </li>
  );
}

function PageHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <div className="sset-head">
      <h2>{title}</h2>
      {lead ? <p>{lead}</p> : null}
    </div>
  );
}

/** One word for each, on every device: the computer's "Match system" is the phone's too (#1424). */
const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match system' },
];

/** Light, Dark or Match system as three drawn previews in one radio group, with arrow keys. */
function ThemeChoices() {
  const theme = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = THEMES.findIndex((item) => item.id === theme);
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length]!;
    setTheme(next.id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-theme-option="${next.id}"]`)?.focus());
  };
  return (
    <div ref={ref} className="sset-themes" role="radiogroup" aria-label="Theme" onKeyDown={move}>
      {THEMES.map((item) => (
        <button key={item.id} type="button" role="radio" className="sset-theme" data-theme-option={item.id} aria-checked={theme === item.id}
          tabIndex={theme === item.id ? 0 : -1} onClick={() => setTheme(item.id)}>
          <span className={`sset-theme__art sset-theme__art--${item.id}`} aria-hidden="true"><i /><i /><i /></span>
          <span className="sset-theme__label"><span className="sset-radio" aria-hidden="true" />{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Kreska's small moments in plain words, the same on every device: it is a face, not a name to know (#1424). */
function KreskaSwitch() {
  const on = useSmallMoments();
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <SwitchRow icon={<Kreska size={phone ? 26 : 22} />} label="Show the face on loading and empty screens"
      detail={phone ? undefined : 'Also when an agent is thinking, the Inbox is empty or you are offline.'} checked={on} onChange={setSmallMoments} />
  );
}

const TEXT_SIZES: { id: TextSize; label: string }[] = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
];

/** Text size on the computer: Small, Default or Large as one segmented choice, with arrow keys. */
function TextSizeChoice() {
  const size = useTextSize();
  const labelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = TEXT_SIZES.findIndex((item) => item.id === size);
    const next = TEXT_SIZES[(index + delta + TEXT_SIZES.length) % TEXT_SIZES.length]!;
    setTextSize(next.id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-text-size-option="${next.id}"]`)?.focus());
  };
  return (
    <div className="sset-row sset-row--size">
      <span className="sset-row__t" id={labelId}>Text size</span>
      <div ref={ref} className="seg sset-size" role="radiogroup" aria-labelledby={labelId} onKeyDown={move}>
        {TEXT_SIZES.map((item) => (
          <button key={item.id} type="button" role="radio" className="seg__b" data-text-size-option={item.id}
            aria-checked={size === item.id} tabIndex={size === item.id ? 0 : -1} onClick={() => setTextSize(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReduceMotionSwitch() {
  const reduce = useReduceMotion();
  return <SwitchRow label="Reduce motion" checked={reduce} onChange={setReduceMotion} />;
}

const THEME_LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'Match system' };

/**
 * AI, on its own page (Settings → AI, and the phone's section): Connect AI with every connection (#854), your agents (#857),
 * and the person's own agent apps.
 */
function AgentsAndAi() {
  const { me } = useShellData();
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [assistant, setAssistant] = useState<PersonalAssistantStatus | null>(null);
  // The caller's own API keys only; the list is owner-scoped on the server. Connect AI shows them.
  const [keys, setKeys] = useState<BackgroundComputeConnection[] | null>(null);
  const [keysFailed, setKeysFailed] = useState(false);
  // Connect AI lists a connection, usable or not: Your agents says what waits for it (#1173).
  const [listed, setListed] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadKeys = useCallback((signal?: AbortSignal) => {
    listBackgroundConnections(signal).then((list) => { setKeys(list); setKeysFailed(false); }, () => { if (!signal?.aborted) { setKeys([]); setKeysFailed(true); } });
  }, []);
  const loadConnections = useCallback((signal?: AbortSignal) => {
    listAgentConnections(signal).then((list) => { setConnections(list); setFailed(false); }, (error: unknown) => { if (!signal?.aborted) { setConnections([]); setFailed(!!error); } });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadConnections(controller.signal);
    getAssistantStatus(controller.signal).then(setAssistant, () => undefined);
    loadKeys(controller.signal);
    return () => controller.abort();
  }, [loadKeys, loadConnections]);
  // An agent's own connection (it answers inside Flux) is not an app on the person's computer.
  const mine = (connections ?? []).filter((connection) => !connection.revokedAt && connection.ownerUserId === me.user.id && connection.computeSource !== 'owner_assistant');
  const dropped = (connectionId: string) => setConnections((current) => (current ?? []).filter((connection) => connection.id !== connectionId));
  const clientRows = mine.length ? <ClientRows connections={mine} onDisconnected={dropped} /> : null;
  // In-app AI off on this server (#763 SG-2): no provider and no agent sign-in, so no Connect AI with choices nothing could use. The page is the person's
  // own Claude Code or Codex, one row each (or the one row that connects it), then one status line.
  const serverOff = assistant?.setup.provider === 'off' && assistant.setup.runtime?.state === 'off' && !assistant.enablement && keys !== null && !keys.length;
  if (serverOff) {
    return (
      <div data-ai-settings="server-off">
        <ul className="sset-card" aria-busy={connections === null || undefined}>
          {clientRows}
          <LinkRow to="/settings/agents/connect" icon={<Icon name="terminal" size={16} />} title="Claude Code or Codex on your computer"
            detail="For code on your computer. Same rules as your agents." action={mine.length ? 'Connect another' : 'Connect'} />
        </ul>
        {connections === null ? <p className="sset-note"><Spinner label="Loading your agents" /></p> : null}
        {failed ? <p className="sset-note" role="note">Your connected apps couldn’t be loaded. <button type="button" className="ui-link" onClick={() => loadConnections()}>Try again</button></p> : null}
        <p className="sset-note">{SERVER_AI_OFF_LINE}. Your agents wait until it is on.</p>
      </div>
    );
  }
  return (
    <>
      {/* #854, #857 (mockup Main): Connect AI first, with every connection and its usage line, and the person's own Claude Code or Codex as rows of
          the same card (#1363); then the person's agents, each using one of them. */}
      <ConnectAi apiKeys={assistant ? assistant.setup.provider === 'on' : true} keys={keys} keysFailed={keysFailed} onRetryKeys={() => loadKeys()} onListed={setListed} clients={clientRows} />
      {failed ? <p className="sset-note" role="note">Your connected apps couldn’t be loaded. <button type="button" className="ui-link" onClick={() => loadConnections()}>Try again</button></p> : null}
      <AgentsList listed={listed} />
    </>
  );
}

/** Settings → Appearance: one neutral palette, text size, motion and Kreska; on the phone also This phone. */
export function SettingsAppearance() {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        {phone ? <h2 className="sset-sec">Appearance</h2> : (
          <PageHead title="Appearance" lead="Flux uses one neutral palette. Status is shown by shape and words, so it reads the same in both themes." />
        )}
        <ThemeChoices />
        {phone ? <h2 className="sset-sec">This phone</h2> : null}
        {/* Notifications and installing Flux on this device live under Notifications → This device (#763 SG-8). */}
        <div className="sset-card">
          {/* On the phone the text size follows the phone's own setting, so there is nothing here to choose or to read. */}
          {phone ? null : <><TextSizeChoice /><ReduceMotionSwitch /></>}
          <KreskaSwitch />
        </div>
      </div>
    </div>
  );
}

/**
 * Settings on the phone (Spokój E04p): the account, the same sections in the same order as the computer's
 * list (Keyboard shortcuts only with a keyboard, so not here), and Sign out.
 */
function PhoneSettings() {
  const { me, workspace, agents } = useShellData();
  const theme = useTheme();
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        {/* The header already says "Settings": one title on the phone. */}
        <Link to="/settings/account" className="sset-card sset-me sset-me--link">
          <Avatar name={me.user.name} id={me.user.id} tone="me" size="lg" />
          <span className="sset-me__b"><b>{me.user.name}</b><span>{me.user.email}</span></span>
          <Icon name="chevron-right" size={14} className="sset-row__go" />
        </Link>
        <ul className="sset-card sset-gap">
          <LinkRow to="/settings/appearance" icon={<Icon name="sun" size={16} />} title="Appearance" detail={THEME_LABEL[theme]} />
          <LinkRow to="/settings/notifications" icon={<Icon name="bell" size={16} />} title="Notifications" detail="Needs you and quiet hours" />
          {isGuest(workspace) ? null : <LinkRow to="/settings/agents" icon={<Icon name="spark" size={16} />} title="AI" detail={agents.length ? `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}` : undefined} />}
          <LinkRow to="/settings/company" icon={<Icon name="people" size={16} />} title="Company" detail={workspace ? `${workspace.name} · its people and their roles` : 'Its people and their roles'} />
        </ul>
        <Form method="post" action="/sign-out" className="sset-card sset-gap">
          <button type="submit" className="sset-row sset-row--link">
            <span className="sset-row__ic" aria-hidden="true"><Icon name="sign-out" size={16} /></span>
            <span className="sset-row__b"><span className="sset-row__t">Sign out</span></span>
          </button>
        </Form>
      </div>
    </div>
  );
}

/** The Settings index: Appearance on the computer (the section list is beside it), the section list on the phone. */
export function SettingsHome() {
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? <PhoneSettings /> : <SettingsAppearance />;
}

/** Settings → AI on its own page: Connect AI, your agents and agent apps. */
export function SettingsAgents() {
  const { workspace } = useShellData();
  // A guest has no agents and no AI (AG-2): not Connect AI, not Your agents. A direct link says so instead of a page of controls.
  if (isGuest(workspace)) {
    return (
      <div className="pane-scroll">
        <div className="pane-in sset-in">
          <PageHead title="AI" />
          <p className="sset-note" data-ai-settings="guest">Guests don’t have AI. An admin can make you a member.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        <PageHead title="AI" lead="Your AI works as agents. Each one has a name, instructions, a model and what it remembers, and can do only what you can." />
        <AgentsAndAi />
      </div>
    </div>
  );
}

/**
 * Settings › Company (F-037, #874; #763 PE-1): the company's name and its people with their roles, in one stable place.
 * Owners and admins rename it, add people, change roles and remove them; everyone else reads. There is no AI switch here:
 * AI is switched per space.
 */
export function SettingsCompany() {
  const { workspace } = useShellData();
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        {phone ? null : <PageHead title="Company" />}
        {workspace ? <WorkspacePeople key={workspace.id} workspaceId={workspace.id} page onBack={() => undefined} />
          : <p className="sset-note">You’re not in a company on this Flux yet. Ask an admin for an invite link.</p>}
      </div>
    </div>
  );
}

const LINK_NOTES: Record<string, string> = {
  linked: 'Single sign-on is linked to this account. Its address and data stay as they are.',
  identity_held: 'That provider account already belongs to another Flux account, so nothing was linked.',
  already_linked: 'This account is already linked to a different provider account, so nothing was linked.',
};

/** Prepare mode (#315): the owner links the provider to this password account before cutover. */
function SingleSignOnLink() {
  const [params] = useSearchParams();
  const [capabilities, setCapabilities] = useState<IdentityCapabilities | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getCapabilities(controller.signal).then(setCapabilities).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const providerId = capabilities?.sso?.providerId;
  useEffect(() => {
    if (!providerId) return;
    const controller = new AbortController();
    getLinkState(providerId, controller.signal).then((state) => setLinked(state.linked)).catch(() => undefined);
    return () => controller.abort();
  }, [providerId]);
  if (!capabilities?.linkable || !capabilities.sso) return null;
  const outcome = params.get('link');
  const note = outcome ? (LINK_NOTES[outcome] ?? 'The link did not complete. Start again.') : '';
  const start = async () => {
    setBusy(true); setFailed('');
    try {
      await startLink();
      const { url } = await startSso(capabilities.sso!.providerId, '/settings/account');
      window.location.assign(url);
    } catch {
      setBusy(false);
      setFailed('Linking did not start. Check your connection and try again.');
    }
  };
  return (
    <section className="sset-card sset-gap" aria-labelledby="set-sso">
      <div className="sset-row">
        <div className="sset-row__b">
        <h2 className="sset-row__t" id="set-sso">Single sign-on</h2>
        {linked ? (
          <p className="sset-row__s">{capabilities.sso.label} is linked to this account. Your Flux account, data and memberships stay the same.</p>
        ) : (
          <p className="sset-row__s">Link {capabilities.sso.label} to this account before Flux moves to single sign-on. Your Flux account, data and memberships stay the same.</p>
        )}
        {note ? <p role="status">{note}</p> : null}
        {failed ? <p role="alert">{failed}</p> : null}
        </div>
        {linked ? null : <Button variant="secondary" busy={busy} onClick={() => void start()}>{`Link ${capabilities.sso.label}`}</Button>}
      </div>
    </section>
  );
}


const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Settings → Account: who is signed in, their name, address and password, where they are signed in, and Sign out (#763 SG-1). */
export function SettingsAccount() {
  const { me } = useShellData();
  const navigation = useNavigation();
  const signingOut = navigation.state !== 'idle' && navigation.formAction === '/sign-out';
  const expires = new Date(me.session.expiresAt);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        <PageHead title="Account" />
        <SingleSignOnLink />
        <section className="sset-card sset-me" aria-label="Signed in as">
          <Avatar name={me.user.name} id={me.user.id} tone="me" size="lg" />
          <div className="sset-me__b">
            <b>{me.user.name}</b>
            <span>{me.user.email}</span>
            <span className="sset-me__session">Signed in on this device until <time dateTime={me.session.expiresAt}>{Number.isNaN(expires.getTime()) ? me.session.expiresAt : dateFormat.format(expires)}</time></span>
          </div>
        </section>
        <AccountEditing userId={me.user.id} name={me.user.name} email={me.user.email} />
        <LastActiveSwitch shows={me.user.showLastActive} />
        <Form method="post" action="/sign-out" className="sset-card sset-gap">
          <button type="submit" className="sset-row sset-row--link" aria-disabled={signingOut || undefined}>
            <span className="sset-row__ic" aria-hidden="true">{signingOut ? <Spinner /> : <Icon name="sign-out" size={16} />}</span>
            <span className="sset-row__b"><span className="sset-row__t">{signingOut ? 'Signing out…' : 'Sign out'}</span><span className="sset-row__s">On this device only</span></span>
          </button>
        </Form>
      </div>
    </div>
  );
}

/** The keyboard shortcuts of guide §4, as one list. */
export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['C'], action: 'New (task by default)' },
  { keys: ['⌘', 'K'], action: 'Search or run' },
  { keys: ['G', 'I'], action: 'Go to Inbox' },
  { keys: ['J', '/', 'K'], action: 'Move in a list' },
  { keys: ['E'], action: 'Done' },
  { keys: ['S'], action: 'Not now' },
  { keys: ['A'], action: 'Accept' },
  { keys: ['Z'], action: 'Undo' },
  { keys: ['R'], action: 'Reply in thread' },
  { keys: ['T'], action: 'Create a task from a message' },
  { keys: ['1', '–', '4'], action: 'Task state' },
  { keys: ['['], action: 'Collapse the sidebar' },
  { keys: ['Esc'], action: 'Close a panel or menu' },
];

export function KeyboardShortcuts() {
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in">
        <PageHead title="Shortcuts" lead="On a computer, or a tablet with a keyboard. The keys also show next to their actions in menus." />
        <table className="sset-card sset-keys">
          <caption className="ui-vh">Shortcuts</caption>
          <thead className="ui-vh"><tr><th scope="col">Keys</th><th scope="col">Action</th></tr></thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.action}>
                <td>{shortcut.keys.map((key, index) => (key === '/' || key === '–'
                  ? <span key={index} className="sset-keys__or">{key === '/' ? 'or' : 'to'}</span>
                  : <kbd key={index}>{key}</kbd>))}</td>
                <th scope="row">{shortcut.action}</th>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
