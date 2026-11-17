/**
 * A person's name in a row with no room to spare (round 14 daily P2-3: "Ola Nowicka (…" on every own card beside an open panel): the name
 * gives way with an ellipsis and its mark, "(you)" or "(removed)", stays whole after it, so the reader still sees which name is theirs.
 * The words read as the one label `youLabel` makes ("Ola Nowicka (you)"), for a screen reader too.
 */
export function PersonName({ name, mark, className }: { name: string; mark?: string | null; className?: string }) {
  return (
    <span className={['ui-name', className].filter(Boolean).join(' ')}>
      <span className="ui-name__n">{name}</span>{mark ? <span className="ui-name__m">{` (${mark})`}</span> : null}
    </span>
  );
}
