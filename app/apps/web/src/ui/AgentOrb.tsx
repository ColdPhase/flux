import { useLoopPause } from './motion';
import { ASSISTANT_PALETTE, agentPalette, orbClassName, type OrbSize } from './orb-palette';

type OrbOwner = { assistant: true; agentId?: never } | { agentId: string; assistant?: false };

/**
 * An agent's face on a phone (F-025 PA-2): a sphere of soft gradients under one shared static grain, drawn in CSS
 * with no WebGL. Decorative: the name and the "AI" badge beside it say who it is. `live` is for an agent that is
 * genuinely working (PA-3): only then does it turn, and only while it can be seen. People never get an orb.
 */
export function AgentOrb(props: OrbOwner & { live?: boolean; size?: OrbSize }) {
  const { live = false, size = 'sm' } = props;
  // Observers only for a turning orb: a long stream of still orbs costs nothing.
  const loop = useLoopPause<HTMLSpanElement>();
  const palette = props.assistant ? ASSISTANT_PALETTE : agentPalette(props.agentId);
  return <span ref={live ? loop : undefined} className={orbClassName(palette, size, live)} data-orb={palette} aria-hidden="true" />;
}

/** The words that go with every orb, so an agent is never told apart by colour alone (F-025 PA-2). */
export function AiBadge() {
  return <span className="ui-ai-badge">AI</span>;
}
