import { agentNamed, ownerInLabel } from '@flux/contracts';
import { Kreska, type KreskaExpression, type AgentHue } from './Kreska';

/** The "Agent" tag: a pill with a small Kreska, so an agent is never mistaken for a person (F-026 P3); the face in the agent's colour (#1528). */
export function AgentTag({ hue }: { hue?: AgentHue | undefined } = {}) {
  return <span className="agent-tag"><Kreska size={12} {...(hue ? { hue } : {})} />Agent</span>;
}


/**
 * An agent as the final design names it (principle 5, #1364): (Kreska,) and its one label on one line, "Ada's Planner": its owner's first name
 * and its own name, the very name an answer Ada showed everyone has (#1232), so one agent never has two names on one screen (v0.2.1 release
 * gate round 15, ai P2-5). An owner who left the company or was removed is named by their marked name, "Stefan Kowal (removed)'s Planner"
 * (`ownerInLabel`, #1424). Until the owner is known (a read that failed or has not come yet) the name keeps the "Agent" tag and never shows an
 * owner it could not confirm. `tag` adds the tag to a known agent too: a message's name line, where an answer shown to everyone has it (#1232).
 * `icon` is false where Kreska already stands in the avatar column; `hue` is the agent's own colour, which every read carries (#1528), for its
 * icon and its tag's face. `expression` only where the icon shows a real state: without one the icon stays still (#1342).
 */
export function AgentIdentity({ name, owner, icon = 20, expression, hue, className, tag = false }: {
  name: string; owner?: string | null; icon?: number | false; expression?: KreskaExpression; hue?: AgentHue | undefined; className?: string; tag?: boolean;
}) {
  const label = owner ? agentNamed(name, owner) : name;
  return (
    <span className={`agent-id${className ? ` ${className}` : ''}`}>
      {icon ? <Kreska size={icon} expression={expression} hue={hue} /> : null}
      {/* The owner's part keeps its own span (`agent-for`), so what names an owner the reader may know can be found; it reads as one name. */}
      <span className="agent-id__label" title={owner ? label : undefined}><span className="agent-id__name">
        {owner ? <><span className="agent-for">{`${ownerInLabel(owner)}'s`}</span>{' '}</> : null}{name}</span></span>
      {owner && !tag ? null : <AgentTag hue={hue} />}
    </span>
  );
}
