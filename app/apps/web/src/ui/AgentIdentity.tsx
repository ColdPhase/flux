import { Kreska, type KreskaExpression, type AgentHue } from './Kreska';

/** The "Agent" tag: a pill with a small Kreska, so an agent is never mistaken for a person (F-026 P3); the face in the agent's colour (#1528). */
export function AgentTag({ hue }: { hue?: AgentHue | undefined } = {}) {
  return <span className="agent-tag"><Kreska size={12} {...(hue ? { hue } : {})} />Agent</span>;
}

/** "Ada" from "Ada Kowalska": an owner is named by their first name in the agent's label. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * An agent as the final design names it (principle 5, #1364): (Kreska,) and its one label on one line, "Planner · Ada's agent". The
 * word "agent" is in the label, so it has no tag of its own; until the owner is known (a read that failed or has not come yet) the name
 * keeps the "Agent" tag and never shows an owner it could not confirm. `icon` is false where Kreska already stands in the avatar column;
 * `hue` is the agent's own colour, which every read carries (#1528), for its icon and its tag's face. `expression` only where the icon shows a real state: without one the icon stays still (#1342).
 */
export function AgentIdentity({ name, owner, icon = 20, expression, hue, className }: {
  name: string; owner?: string | null; icon?: number | false; expression?: KreskaExpression; hue?: AgentHue | undefined; className?: string;
}) {
  return (
    <span className={`agent-id${className ? ` ${className}` : ''}`}>
      {icon ? <Kreska size={icon} expression={expression} hue={hue} /> : null}
      <span className="agent-id__label" title={owner ? `${name} · ${firstName(owner)}'s agent` : undefined}>
        <span className="agent-id__name">{name}</span>
        {owner ? <span className="agent-for">{` · ${firstName(owner)}'s agent`}</span> : null}
      </span>
      {owner ? null : <AgentTag hue={hue} />}
    </span>
  );
}
