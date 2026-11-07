import { Link, useParams } from 'react-router';
import { useShellData } from '../app/data';
import { Icon, Kreska } from '../ui';
import './my-agents.css';

/**
 * An agent as a private conversation in Messages (F-036 AG-4, #857; mockup AgentReports): its header, the line that only its
 * owner talks to it, and where its reports and answers arrive. The owner's messages and the agent's answers come with `/ai` and
 * the private conversation (#842); until then nothing is written here, and nothing says otherwise.
 */
export function AgentConversation() {
  const { agentId = '' } = useParams();
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div className="pane-scroll"><div className="pane-in agc">
        <p className="agc__note">This agent isn’t here. It may have been deleted. <Link className="ui-link" to="/dm">Back to Messages</Link></p>
      </div></div>
    );
  }
  return (
    <div className="pane-scroll"><div className="pane-in agc" data-agent-conversation={agent.id}>
      <div className="agc__bar">
        <span className="agc__who"><Kreska size={24} hue={agent.colour} /><b>{agent.name}</b><span className="agc__tag">Your agent</span></span>
        <Link className="ui-link agc__settings" to={`/settings/agents/${agent.id}`}>Settings</Link>
      </div>
      <p className="agc__note"><Icon name="lock" size={13} />Only you talk to {agent.name}. Reports of its work arrive here.</p>
      <p className="agc__empty">Nothing here yet.</p>
    </div></div>
  );
}
