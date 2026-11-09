import { day } from '../app/messageParts';

/**
 * Author runs and day lines for a list of messages, as every private surface groups them. A message posted "via" an assistant (Show everyone) or
 * a client starts its own run: its mark is drawn with the name, so it is never hidden under the person's own message before it (#1091).
 */
export function groupRows<T extends { authorId: string; at: string; via?: string | null }>(lines: readonly T[]) {
  const same = (a: T, b: T) => a.authorId === b.authorId && (a.via ?? null) === (b.via ?? null);
  return lines.map((line, index) => {
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const label = day(line.at);
    const newDay = !previous || day(previous.at) !== label;
    return { line, label, newDay, continued: !newDay && !!previous && same(previous, line), groupLast: !next || !same(line, next) || day(next.at) !== label };
  });
}
