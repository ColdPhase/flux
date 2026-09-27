import { Icon } from '../ui';
import { WorkDetails } from '../work/WorkDetails';
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

/**
 * "Connect your AI" (#57, PR #64). An assistant always belongs to one person and only its owner
 * can use it. No compute path exists in this version, so the options are listed honestly as
 * not available yet and nothing here calls a model.
 */
function ConnectAi({ onBack }: { onBack: () => void }) {
  return (
    <div className="details">
      <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>
      <p className="details__eyebrow">Optional</p>
      <h3 className="details__title">Connect your AI</h3>
      <p className="details__lead">Flux works fully without AI. If you connect an assistant, it is yours: only you can use it, you pay for it, and it sees only what you can see.</p>
      <section className="details__sec" aria-labelledby="details-ai-ways">
        <h4 id="details-ai-ways">Ways to connect</h4>
        <ul className="details__rows">
          <li><b>Claude Code on your computer</b><span>Through a personal Flux grant, using its own plan · not available yet</span></li>
          <li><b>A personal API key</b><span>Asks for your spending cap before the first run · not available yet</span></li>
        </ul>
      </section>
      <section className="details__sec" aria-labelledby="details-ai-now">
        <h4 id="details-ai-now">Until then</h4>
        <p>The ✦ button explains this and sends nothing. Your notes and unsent text stay as they are.</p>
      </section>
    </div>
  );
}
