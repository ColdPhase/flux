import { day } from '../app/messageParts';

/** Author runs and day lines for a list of messages, as every private surface groups them. */
export function groupRows<T extends { authorId: string; at: string }>(lines: readonly T[]) {
  return lines.map((line, index) => {
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const label = day(line.at);
    const newDay = !previous || day(previous.at) !== label;
    return { line, label, newDay, continued: !newDay && previous?.authorId === line.authorId, groupLast: !next || next.authorId !== line.authorId || day(next.at) !== label };
  });
}
