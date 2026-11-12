import { Avatar } from './Avatar';
import { Kreska, type AgentHue } from './Kreska';

/** The decorative 32px author column shared by messages and authored events (F-026). `hue` is an agent's own colour, where the message carries it (#1232). */
export function AuthorFace({ kind, id, name, mine = false, hue }: { kind: 'human' | 'agent'; id?: string | null; name: string; mine?: boolean; hue?: AgentHue }) {
  // An agent is Kreska and never has a photo (F-039); a person's id draws theirs.
  return kind === 'agent' ? <Kreska size={32} className="author-face" {...(hue ? { hue } : {})} /> : <Avatar name={name} id={id} size="lg" tone={mine ? 'me' : 'neutral'} />;
}
