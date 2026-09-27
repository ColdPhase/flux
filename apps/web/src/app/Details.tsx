import type { MeResponse } from '../api/auth';
import type { WorkspaceSummary } from './data';

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Lets a long address wrap after the @ instead of mid-word. */
function breakableEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at < 0) return email;
  return <>{email.slice(0, at)}<wbr />{email.slice(at)}</>;
}

/** Details for the current place. Decisions, work, people and sources join it with projects. */
export function Details({ me, workspace, placeTitle }: { me: MeResponse; workspace: WorkspaceSummary | null; placeTitle: string }) {
  const expires = new Date(me.session.expiresAt);
  return (
    <div className="details">
      <p className="details__eyebrow">{workspace?.name ?? 'Flux'}</p>
      <h3 className="details__title">{placeTitle}</h3>
      <p className="details__lead">Open a thought, a task, a decision or a result and its context appears here: where it came from, what it connects to, and who can see it.</p>

      <section className="details__sec" aria-labelledby="details-account">
        <h4 id="details-account">Your account</h4>
        <dl className="details__dl">
          <dt>Name</dt><dd>{me.user.name}</dd>
          <dt>Email</dt><dd>{breakableEmail(me.user.email)}</dd>
          <dt>Session</dt><dd>Signed in on this device until <time dateTime={me.session.expiresAt}>{Number.isNaN(expires.getTime()) ? me.session.expiresAt : dateFormat.format(expires)}</time></dd>
        </dl>
      </section>

      <section className="details__sec" aria-labelledby="details-audience">
        <h4 id="details-audience">Who can see Home</h4>
        <p>Only you. Notes you capture here stay private until you choose to share them{workspace ? ` in ${workspace.name}` : ''}.</p>
      </section>

      <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
    </div>
  );
}
