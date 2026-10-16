import { getCapabilities, getLinkState, startLink, startSso } from '../api/auth';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Form, Link, Outlet, useLocation, useNavigation, useSearchParams } from 'react-router';
import { aiConnectionLabel, PERSONAL_RUN_LIMITS, type AgentConnection, type BackgroundComputeConnection, type PersonalAssistantStatus, type IdentityCapabilities } from '@flux/contracts';
import { listAgentConnections } from '../agent-connection/api';
import { getAssistantStatus } from '../assistant/api';
import { backgroundComparisonRuntime, listBackgroundConnections } from '../proactive-comparison/api';
import { dollars } from '../assistant/format';
import { NotificationsButton } from '../pwa';
import { AgentTag, Avatar, Button, Icon, Kreska, MEDIA, Spinner, agentHue, setReduceMotion, useMediaQuery, useReduceMotion } from '../ui';
import { RuntimeSection } from '../agent-runtime/RuntimeSection';
import '../agent-connection/connection.css';
import { useShellData } from './data';
import { setSmallMoments, useSmallMoments } from './smallMoments';
import { setTextSize, useTextSize, type TextSize } from './textSize';
import { setTheme, useTheme, type ThemeChoice } from './theme';
import './reading.css';
import './settings.css';

// Settings (F-026, #350; Spokój #513): one calm place with Account, Appearance, Notifications, Agents and AI
// and Keyboard shortcuts, in that order on every device. On the computer the section list sits beside the
// page; on the phone Settings is that list (the account card, then the sections) and each section is a page.
// Keyboard shortcuts appear only where there is a keyboard, so not on touch-only phones and tablets.

const SECTIONS: { to: string; label: string; match: RegExp }[] = [
  { to: '/settings/account', label: 'Account', match: /^\/settings\/account$/ },
  { to: '/settings', label: 'Appearance', match: /^\/settings(\/appearance)?$/ },
  { to: '/settings/notifications', label: 'Notifications', match: /^\/settings\/notifications/ },
  { to: '/settings/agents', label: 'Agents and AI', match: /^\/settings\/(agents|assistant|background-compute|ai-connections)/ },
  { to: '/settings/shortcuts', label: 'Keyboard shortcuts', match: /^\/settings\/shortcuts$/ },
];

/** The section list beside every Settings page on the computer; the phone leads from the Settings page instead. */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const phone = useMediaQuery(MEDIA.phone);
  // A touch-only tablet has no keyboard to use shortcuts with (AC-1).
  const touch = useMediaQuery(MEDIA.touch);
  return (
    <div className="sset">
      {phone ? null : (
        <nav className="sset__nav" aria-label="Settings sections">
          {SECTIONS.filter((section) => !touch || section.to !== '/settings/shortcuts').map((section) => (
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

/** An on/off switch with its label and an optional line under it, the whole row a target. */
export function SwitchRow({ label, detail, checked, onChange, icon, disabled }: {
  label: string; detail?: ReactNode; checked: boolean; onChange: (on: boolean) => void; icon?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="sset-row">
      {icon ? <span className="sset-row__ic" aria-hidden="true">{icon}</span> : null}
      <label className="sset-row__b" htmlFor={id}>
        <span className="sset-row__t">{label}</span>
        {detail ? <span className="sset-row__s" id={`${id}-d`}>{detail}</span> : null}
      </label>
      <button type="button" role="switch" id={id} className="sset-switch" aria-checked={checked} disabled={disabled}
        aria-describedby={detail ? `${id}-d` : undefined} onClick={() => onChange(!checked)}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

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

const THEMES: { id: ThemeChoice; label: string; phoneLabel: string }[] = [
  { id: 'light', label: 'Light', phoneLabel: 'Light' },
  { id: 'dark', label: 'Dark', phoneLabel: 'Dark' },
  { id: 'system', label: 'Match system', phoneLabel: 'System' },
];

/** Light, Dark or Match system as three drawn previews in one radio group, with arrow keys. */
function ThemeChoices() {
  const theme = useTheme();
  const phone = useMediaQuery(MEDIA.phone);
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
          <span className="sset-theme__label"><span className="sset-radio" aria-hidden="true" />{phone ? item.phoneLabel : item.label}</span>
        </button>
      ))}
    </div>
  );
}

function KreskaSwitch() {
  const on = useSmallMoments();
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <SwitchRow icon={<Kreska size={phone ? 26 : 22} />} label={phone ? 'Kreska in small moments' : 'Kreska in loading and empty screens'}
      detail={phone ? undefined : 'Small moments: loading, agent thinking, empty Inbox, offline'} checked={on} onChange={setSmallMoments} />
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

/** On the phone the text size follows the system setting: a plain value, with no control to change it. */
function TextSizeFollowsPhone() {
  return (
    <div className="sset-row">
      <span className="sset-row__b"><span className="sset-row__t">Text size</span></span>
      <span className="sset-row__go">Follows your phone</span>
    </div>
  );
}

function ReduceMotionSwitch() {
  const reduce = useReduceMotion();
  return <SwitchRow label="Reduce motion" checked={reduce} onChange={setReduceMotion} />;
}

const ASSISTANT_STATE: Record<PersonalAssistantStatus['state'], string> = {
  not_enabled: 'not set up', ready: 'in Flux', paused: 'paused', capped: 'daily limit reached', unavailable: 'unavailable',
};
const DESIGNATION: Record<AgentConnection['clientDesignation'], string> = { claude_code: 'Claude Code', codex: 'Codex', other: 'another app' };
const THEME_LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/**
 * The assistant card (Spokój E04): Kreska, name, "Agent", one status line, three short facts and one
 * primary step. Costs, data and consent live in the set-up step and on "How it works".
 */
function AssistantCard({ userId, status }: { userId: string; status: PersonalAssistantStatus | null }) {
  // In-app AI off on this server (AC-3): the card says so in its one status line; Set up stays in place, dimmed.
  const off = status?.setup.provider === 'off';
  return (
    <section className="sset-card sset-assistant" aria-labelledby="assistant-card">
      <div className="sset-assistant__head">
        <span className="sset-row__ic" aria-hidden="true"><Kreska size={26} hue={agentHue(`assistant:${userId}`)} /></span>
        <div className="sset-row__b">
          <h4 className="sset-row__t" id="assistant-card"><span className="sset-row__identity">Your assistant <AgentTag /></span></h4>
          <span className="sset-row__s">{off ? 'In-app AI is off on this Flux server' : `for you · ${status ? ASSISTANT_STATE[status.state] : 'loading'}`}</span>
          {status?.enablement && !off ? <span className="sset-row__s">Paid by {status.enablement.consent.payer.organization} · {aiConnectionLabel(status.enablement.consent.provider, status.enablement.consent.model)} · Assistant {status.enablement.status === 'active' ? 'on' : 'paused'}</span> : null}
        </div>
        {off ? <Button variant="primary" disabled>Set up</Button>
          : <Link className="ui-btn ui-btn--primary" to="/settings/assistant">{status?.enablement ? 'Manage' : 'Set up'}</Link>}
      </div>
      {off ? null : (
        <>
          <ul className="sset-assistant__facts">
            <li>Answers only when you ask it, in a project you choose.</li>
            <li>Uses your own AI connection. You pay your provider, never Flux.</li>
            <li>Stops at a daily cap you set (default {dollars(PERSONAL_RUN_LIMITS.dailyCapCents.default)}).</li>
          </ul>
          <Link className="ui-link sset-assistant__how" to="/settings/assistant/how">How it works</Link>
        </>
      )}
    </section>
  );
}

/** Background suggestions: a link when the server runs them, one status line when it does not (Spokój E04 ③). */
function BackgroundRow({ runtime }: { runtime: 'available' | 'unavailable' | null }) {
  if (runtime === 'unavailable') {
    return (
      <li className="sset-row">
        <span className="sset-row__ic" aria-hidden="true"><Icon name="leaf" size={16} /></span>
        <span className="sset-row__b"><span className="sset-row__t">Background suggestions</span><span className="sset-row__s">Off on this Flux server · ask your admin to turn it on</span></span>
      </li>
    );
  }
  return <LinkRow to="/settings/background-compute" icon={<Icon name="leaf" size={16} />} title="Background suggestions"
    detail="Optional comparisons from your own connection and allowance" action="Manage" />;
}

/**
 * Agents and AI, on its own page (Settings → Agents and AI, and the phone's section): the assistant card first,
 * then the sign-in choices with the API key ones under them (#277 Connect AI), background suggestions, and the
 * person's own agent apps with their colours (the only place outside the Agents view where agents have colour).
 */
function AgentsAndAi() {
  const { me } = useShellData();
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [assistant, setAssistant] = useState<PersonalAssistantStatus | null>(null);
  const [runtime, setRuntime] = useState<'available' | 'unavailable' | null>(null);
  const [keys, setKeys] = useState<BackgroundComputeConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listAgentConnections(controller.signal).then(setConnections, (error: unknown) => { if (!controller.signal.aborted) { setConnections([]); setFailed(!!error); } });
    getAssistantStatus(controller.signal).then(setAssistant, () => undefined);
    backgroundComparisonRuntime(controller.signal).then((answer) => setRuntime(answer.status), () => { if (!controller.signal.aborted) setRuntime('unavailable'); });
    // The caller's own AI connections only; the list is owner-scoped on the server.
    listBackgroundConnections(controller.signal).then(setKeys, () => { if (!controller.signal.aborted) setKeys([]); });
    return () => controller.abort();
  }, []);
  const mine = (connections ?? []).filter((connection) => !connection.revokedAt && connection.ownerUserId === me.user.id);
  // Other ways to connect: the API key choices (F-027 AST-1.2: shown plainly when sign-in is off).
  const otherWays = (
    <>
      <ul className="sset-card">
        <LinkRow to="/settings/ai-connections" icon={<Icon name="key" size={16} />} title="Use an API key"
          detail="Your own key from a provider, with your own limits and payer" action="Manage" />
        {(keys ?? []).map((key) => (
          <LinkRow key={key.id} to="/settings/ai-connections" icon={<Icon name="key" size={16} />}
            title={<>{key.name}<span className="sset-row__meta"> · {aiConnectionLabel(key.provider, key.model)}</span></>}
            detail={`Paid by ${key.payerOrganization} · Assistant ${assistant?.enablement?.connectionId === key.id ? 'on' : 'off'} · Background suggestions ${key.usedForBackground ? 'on' : 'off'}`} action="Manage" />
        ))}
      </ul>
      {keys !== null && !keys.length ? <p className="sset-note">No AI connection of your own yet. Add one under Use an API key to use your assistant.</p> : null}
    </>
  );
  return (
    <>
      {/* Spokój E04: the assistant card first. Then the one Connect AI entry (F-022 T2, #277; F-027 AST-1): the
          sign-in choices, with the API key choices under them, and background suggestions. */}
      <section aria-labelledby="ai-in-flux">
        <h3 className="sset-sub" id="ai-in-flux">Agent in Flux</h3>
        <p className="sset-note sset-note--sub">Works inside Flux when you ask. You choose the AI and who pays for it.</p>
        <AssistantCard userId={me.user.id} status={assistant} />
        <RuntimeSection otherWays={otherWays} />
        <ul className="sset-card sset-gap">
          <BackgroundRow runtime={runtime} />
        </ul>
      </section>
      <section aria-labelledby="ai-agent-app">
        <h3 className="sset-sub" id="ai-agent-app">Your agent app</h3>
        <p className="sset-note sset-note--sub">Claude Code, Codex or another app on your own computer, with its own account. Flux never receives its credentials.</p>
        <ul className="sset-card" aria-busy={connections === null || undefined}>
          <LinkRow to="/connect-agent" icon={<Icon name="monitor" size={16} />} title="Local co-work on this computer"
            detail="Claude Code, Codex or another app · connect it to Flux" action="Manage" />
          {mine.map((connection) => (
            <LinkRow key={connection.id} to="/connect-agent" icon={<Kreska size={22} hue={agentHue(connection.agentId)} />}
              title={<><span className="sset-row__identity">{connection.name}{' '}<AgentTag /></span><span className="sset-row__meta"> · for you · {DESIGNATION[connection.clientDesignation]} · connected</span></>} action="Manage" />
          ))}
        </ul>
        {connections === null ? <p className="sset-note"><Spinner label="Loading your agents" /></p> : null}
        {failed ? <p className="sset-note" role="note">Your connected agents could not be listed. Manage them under Local co-work.</p> : null}
      </section>
    </>
  );
}

/** Settings → Appearance: one neutral palette, text size, motion and Kreska; on the phone also This phone. */
export function SettingsAppearance() {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in" data-shift>
        {phone ? <h2 className="sset-sec">Appearance</h2> : (
          <PageHead title="Appearance" lead="Flux uses one neutral palette. Status is shown by shape and words, so it reads the same in both themes." />
        )}
        <ThemeChoices />
        {phone ? <p className="sset-note">One neutral palette. There is no accent color to pick.</p> : null}
        {phone ? <h2 className="sset-sec">This phone</h2> : null}
        <div className="sset-card">
          {phone ? <div className="sset-row sset-row--stack"><span className="sset-row__t">Notifications on this phone</span><NotificationsButton /></div> : null}
          {phone ? <TextSizeFollowsPhone /> : <><TextSizeChoice /><ReduceMotionSwitch /></>}
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
  const { me } = useShellData();
  const theme = useTheme();
  const [assistant, setAssistant] = useState<PersonalAssistantStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setAssistant, () => undefined);
    return () => controller.abort();
  }, []);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in" data-shift>
        {/* The header already says "Settings": one title on the phone. */}
        <Link to="/settings/account" className="sset-card sset-me sset-me--link">
          <Avatar name={me.user.name} tone="me" size="lg" />
          <span className="sset-me__b"><b>{me.user.name}</b><span>{me.user.email}</span></span>
          <Icon name="chevron-right" size={14} className="sset-row__go" />
        </Link>
        <ul className="sset-card sset-gap">
          <LinkRow to="/settings/appearance" icon={<Icon name="sun" size={16} />} title="Appearance" detail={THEME_LABEL[theme]} />
          <LinkRow to="/settings/notifications" icon={<Icon name="bell" size={16} />} title="Notifications" detail="Needs you, quiet hours, morning summary" />
          <LinkRow to="/settings/agents" icon={<Icon name="spark" size={16} />} title="Agents and AI" detail={assistant ? `Assistant ${ASSISTANT_STATE[assistant.state]}` : undefined} />
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

/** Settings → Agents and AI on its own page: the assistant, Connect AI, background suggestions and agent apps. */
export function SettingsAgents() {
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in" data-shift>
        <PageHead title="Agents and AI" lead="Your agents work for you and are always marked as agents. Colours appear only here and in the Agents view." />
        <AgentsAndAi />
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

/** Settings → Account: who is signed in, this session and Sign out (on this device only). */
export function SettingsAccount() {
  const { me } = useShellData();
  const navigation = useNavigation();
  const signingOut = navigation.state !== 'idle' && navigation.formAction === '/sign-out';
  const expires = new Date(me.session.expiresAt);
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in" data-shift>
        <PageHead title="Account" />
        <SingleSignOnLink />
        <section className="sset-card sset-me" aria-label="Signed in as">
          <Avatar name={me.user.name} tone="me" size="lg" />
          <div className="sset-me__b">
            <b>{me.user.name}</b>
            <span>{me.user.email}</span>
            <span className="sset-me__session">Signed in on this device until <time dateTime={me.session.expiresAt}>{Number.isNaN(expires.getTime()) ? me.session.expiresAt : dateFormat.format(expires)}</time></span>
          </div>
        </section>
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
  { keys: ['1', '–', '5'], action: 'Task state' },
  { keys: ['['], action: 'Collapse the sidebar' },
  { keys: ['F'], action: 'Focus mode' },
  { keys: ['Esc'], action: 'Close a panel or menu' },
];

export function KeyboardShortcuts() {
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in" data-shift>
        <PageHead title="Keyboard shortcuts" lead="On a computer, or a tablet with a keyboard. The keys also show next to their actions in menus." />
        <table className="sset-card sset-keys">
          <caption className="ui-vh">Keyboard shortcuts</caption>
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
