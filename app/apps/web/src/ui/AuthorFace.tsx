import { Avatar } from './Avatar';
import { Kreska } from './Kreska';

/** The decorative 32px author column shared by messages and authored events (F-026). */
export function AuthorFace({ kind, id, name, mine = false }: { kind: 'human' | 'agent'; id?: string | null; name: string; mine?: boolean }) {
  // An agent is Kreska and never has a photo (F-039); a person's id draws theirs.
  return kind === 'agent' ? <Kreska size={32} className="author-face" /> : <Avatar name={name} id={id} size="lg" tone={mine ? 'me' : 'neutral'} />;
}
