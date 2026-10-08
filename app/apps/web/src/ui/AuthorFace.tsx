import { Avatar } from './Avatar';
import { Kreska } from './Kreska';

/** The decorative 32px author column shared by messages and authored events (F-026). */
export function AuthorFace({ kind, name, mine = false }: { kind: 'human' | 'agent'; name: string; mine?: boolean }) {
  return kind === 'agent' ? <Kreska size={32} className="author-face" /> : <Avatar name={name} size="lg" tone={mine ? 'me' : 'neutral'} />;
}
