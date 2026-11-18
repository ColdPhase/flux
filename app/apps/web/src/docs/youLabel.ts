/**
 * The one way a person is named as the author or owner of something (design §5 "Naming people"): the full name, and "Ada Kowalska (you)"
 * for the reader, never "You" alone or a first name. `mine` says the person is the reader; `named` decides it from a person and the reader's id.
 * A module of its own so the first screen's people and task labels name the reader without loading the rest of `docs/format` (#850 AC-4).
 */
export const youLabel = (name: string, mine: boolean) => (mine ? `${name} (you)` : name);
export const named = (person: { kind?: string; id: string; name: string }, meId: string) =>
  youLabel(person.name, (person.kind ?? 'human') === 'human' && person.id === meId);
