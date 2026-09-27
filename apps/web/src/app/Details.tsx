import { Icon } from '../ui';
import { WorkDetails } from '../work/WorkDetails';
import { Link } from 'react-router';
import type { WorkspaceSummary } from './data';
import type { DetailsView } from './shellContext';

/**
 * Details for the current place. With nothing selected it says so briefly; the context of a
 * selected message, task, decision or result joins it with conversations (#36). Account and
 * session details live in the account menu.
 */
export function Details({ view, workspace, placeTitle, onBack }: {
  view: DetailsView;
  workspace: WorkspaceSummary | null;
  placeTitle: string;
  onBack: () => void;
}) {
  if (view === 'connect-ai') return <ConnectAi onBack={onBack} />;
  if (typeof view === 'object') return <WorkDetails view={view} />;
  const home = placeTitle === 'Home';
  return (
    <div className="details">
      <p className="details__eyebrow">{placeTitle}</p>
      <h3 className="details__title">Nothing selected</h3>
      <p className="details__lead">Select a note, task or result to see where it came from, what it connects to and who can see it.</p>

      <section className="details__sec" aria-labelledby="details-audience">
        <h4 id="details-audience">Who can see {placeTitle}</h4>
        {home
          ? <p>Only you. Notes you capture here stay private until you choose to share them{workspace ? ` in ${workspace.name}` : ''}.</p>
          : <p>Only the people in each conversation.</p>}
      </section>

      <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
    </div>
  );
}

/** Personal connection setup. The in-app assistant still needs its separate runtime (#58). */
function ConnectAi({ onBack }: { onBack: () => void }) {
  return (
    <div className="details">
      <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>
      <p className="details__eyebrow">Optional</p>
      <h3 className="details__title">Connect your AI</h3>
      <p className="details__lead">Flux works fully without AI. Your own Claude Code client can connect to selected projects, read context and suggest proposals for human review.</p>
      <section className="details__sec" aria-labelledby="details-ai-ways">
        <h4 id="details-ai-ways">Ways to connect</h4>
        <ul className="details__rows">
          <li><b>Claude Code on your computer</b><span>Uses your account for compute and your personal Flux grant. Flux never receives your provider credentials.</span></li>
          <li><b>A personal API key</b><span>Asks for your spending cap before the first run · not available yet</span></li>
        </ul>
        <p><Link className="ui-link" to="/connect-agent">Set up or revoke a Claude Code connection</Link></p>
      </section>
      <section className="details__sec" aria-labelledby="details-ai-now">
        <h4 id="details-ai-now">In-app assistant</h4>
        <p>The ✦ button does not start Claude Code or spend your plan. It remains unavailable until a separate in-app assistant runtime is connected.</p>
      </section>
    </div>
  );
}
