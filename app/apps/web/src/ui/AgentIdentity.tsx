import { Kreska, type KreskaExpression, type AgentHue } from './Kreska';

/** The "Agent" tag: a pill with a small Kreska, so an agent is never mistaken for a person (F-026 P3). */
export function AgentTag() {
  return <span className="agent-tag"><Kreska size={12} />Agent</span>;
}

/**
 * An agent as the final design names it: (Kreska,) its name, the "Agent" tag and "for <owner>". `icon`
 * is false where Kreska already stands in the avatar column; `hue` only inside the Agents section.
 */
export function AgentIdentity({ name, owner, icon = 20, expression = 'idle', hue, className }: {
  name: string; owner?: string | null; icon?: number | false; expression?: KreskaExpression; hue?: AgentHue; className?: string;
}) {
  return (
    <span className={`agent-id${className ? ` ${className}` : ''}`}>
      {icon ? <Kreska size={icon} expression={expression} hue={hue} /> : null}
      <span className="agent-id__name">{name}</span>
      <AgentTag />
      {owner ? <span className="agent-for">for {owner}</span> : null}
    </span>
  );
}
