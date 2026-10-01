export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

export function Avatar({ name, size = 'md', tone = 'neutral' }: { name: string; size?: 'sm' | 'md' | 'lg'; tone?: 'neutral' | 'me' }) {
  return <span className={`ui-avatar ui-avatar--${size} ui-avatar--${tone}`} aria-hidden="true">{initials(name)}</span>;
}
