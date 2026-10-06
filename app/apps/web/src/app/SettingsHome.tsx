import { Form, Link, useNavigation } from 'react-router';
import { Avatar, Icon, Spinner, type IconName } from '../ui';
import { NotificationsButton } from '../pwa';
import { AppearanceControls } from './AppearanceControls';
import { useShellData } from './data';
import { useShellActions } from './shellContext';
import './settings.css';

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Row({ to, icon, title, sub }: { to: string; icon: IconName; title: string; sub: string }) {
  return (
    <li>
      <Link to={to} className="set-row">
        <span className="set-row__ic" aria-hidden="true"><Icon name={icon} size={16} /></span>
        <span className="set-row__b"><span className="set-row__t">{title}</span><span className="set-row__s">{sub}</span></span>
        <Icon name="chevron-right" size={14} className="set-row__go" />
      </Link>
    </li>
  );
}

/**
 * Settings (#266 PF-5): one place for this account, this device and personal AI. Every earlier
 * settings address keeps working; this list is how a person finds them, on a phone in two taps.
 */
const PEOPLE_LINE = {
  owner: 'You’re an owner · add and manage people',
  admin: 'You’re an admin · add and manage people',
  member: 'You’re a member · see who’s here',
  guest: 'You’re a guest · you see only projects given to you',
} as const;

export function SettingsHome() {
  const { me, workspaces } = useShellData();
  const { openDetails } = useShellActions();
  const navigation = useNavigation();
  const signingOut = navigation.state !== 'idle' && navigation.formAction === '/sign-out';
  const expires = new Date(me.session.expiresAt);
  return (
    <div className="pane-scroll">
      <div className="pane-in set" data-shift>
        <section className="set-me" aria-label="Account">
          <Avatar name={me.user.name} tone="me" size="lg" />
          <div className="set-me__b">
            <b>{me.user.name}</b>
            <span>{me.user.email}</span>
            <span className="set-me__session">Signed in on this device until <time dateTime={me.session.expiresAt}>{Number.isNaN(expires.getTime()) ? me.session.expiresAt : dateFormat.format(expires)}</time></span>
          </div>
        </section>

        <section className="set-sec" aria-labelledby="set-appearance">
          <h2 className="set-sec__h" id="set-appearance">This device</h2>
          <div className="set-card set-card--pad">
            <AppearanceControls idPrefix="set" sectionClass="set-field" />
            <div className="set-field">
              <span className="me__label"><Icon name="bell" size={12} />Notifications on this device</span>
              <NotificationsButton />
            </div>
          </div>
        </section>

        {/* Each workspace's people (#188): who is here, and for owners and admins, adding and managing them. */}
        <section className="set-sec" aria-labelledby="set-people">
          <h2 className="set-sec__h" id="set-people">People</h2>
          {workspaces.length ? (
            <ul className="set-card">
              {workspaces.map((space) => (
                <li key={space.id}>
                  <button type="button" className="set-row" onClick={() => openDetails({ kind: 'people', workspaceId: space.id })} aria-haspopup="dialog">
                    <span className="set-row__ic" aria-hidden="true"><Icon name="people" size={16} /></span>
                    <span className="set-row__b"><span className="set-row__t">{space.name}</span><span className="set-row__s">{space.role ? PEOPLE_LINE[space.role] : 'See who is here'}</span></span>
                    <Icon name="chevron-right" size={14} className="set-row__go" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="set-sec__empty">Start a project to create your own space; then you can add people to it.</p>}
        </section>

        <section className="set-sec" aria-labelledby="set-notify">
          <h2 className="set-sec__h" id="set-notify">Notifications</h2>
          <ul className="set-card">
            <Row to="/settings/notifications" icon="bell" title="What reaches you" sub="Inbox, push and email for each kind of activity" />
          </ul>
        </section>

        <section className="set-sec" aria-labelledby="set-ai">
          <h2 className="set-sec__h" id="set-ai">AI</h2>
          <ul className="set-card">
            <Row to="/settings/assistant" icon="spark" title="Agent in Flux" sub="Your own AI connection inside Flux · only you can use it" />
            <Row to="/connect-agent" icon="terminal" title="Agent connections" sub="Claude Code, Codex or any MCP client on your computer" />
            <Row to="/settings/background-compute" icon="leaf" title="Background suggestions" sub="Optional comparisons from your own connection and allowance" />
          </ul>
        </section>

        <section className="set-sec" aria-labelledby="set-account">
          <h2 className="set-sec__h" id="set-account">Account</h2>
          <Form method="post" action="/sign-out" className="set-card">
            <button type="submit" className="set-row set-row--danger" aria-disabled={signingOut || undefined}>
              <span className="set-row__ic" aria-hidden="true">{signingOut ? <Spinner /> : <Icon name="sign-out" size={16} />}</span>
              <span className="set-row__b"><span className="set-row__t">{signingOut ? 'Signing out…' : 'Sign out'}</span><span className="set-row__s">On this device only</span></span>
            </button>
          </Form>
        </section>
      </div>
    </div>
  );
}
