import { day } from '../app/messageParts';

/**
 * Author runs and day lines for a list of messages, as every private surface groups them. A message posted "via" an assistant (Show everyone) or
 * a client starts its own run: its mark is drawn with the name, so it is never hidden under the person's own message before it (#1091).
 * `startsGroup` names a line that starts a group whoever wrote the line before it (#1246: the first new message).
 */
export function groupRows<T extends { authorId: string; at: string; via?: string | null }>(lines: readonly T[], startsGroup: (line: T) => boolean = () => false) {
  const same = (a: T, b: T) => a.authorId === b.authorId && (a.via ?? null) === (b.via ?? null);
  return lines.map((line, index) => {
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const label = day(line.at);
    const newDay = !previous || day(previous.at) !== label;
    // A line that `startsGroup` (the one the "New" divider stands above) begins its own group, as after a day line: its author is named again,
    // and the line before it ends its group.
    return { line, label, newDay, continued: !newDay && !startsGroup(line) && !!previous && same(previous, line), groupLast: !next || !same(line, next) || day(next.at) !== label || startsGroup(next) };
  });
}
