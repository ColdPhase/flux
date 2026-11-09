/** "Jonas", "Jonas and Maja", "Jonas, Maja and Lea": the people a waiting change would notify (#1102). */
export function peopleNamed(people: readonly { name: string }[]): string {
  const names = people.map((person) => person.name);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
