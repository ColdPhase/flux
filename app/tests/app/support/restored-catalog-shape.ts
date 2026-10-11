// pg_dump/restore reparses CHECKs and can flatten nested associative AND/OR nodes.
// Evidence comparison alone permits this rendering change. Migration/refusal comparisons
// and the production preflight keep exact catalog definitions; data/ledger remain exact.
type BooleanShape = string | { operator: 'AND' | 'OR'; terms: BooleanShape[] };
function tokens(sql: string): string[] {
  const result: string[] = [];
  for (let at = 0; at < sql.length;) {
    if (/\s/.test(sql[at])) { at++; continue; }
    const start = at, quote = sql[at];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && at > 0 && /e/i.test(sql[at - 1]);
      at++;
      let closed = false;
      while (at < sql.length) {
        if (escaped && sql[at] === '\\') { at += 2; continue; }
        if (sql[at++] !== quote) continue;
        if (sql[at] === quote) { at++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error('Unterminated catalog CHECK literal');
    } else if (/[a-z0-9_]/i.test(sql[at])) {
      while (at < sql.length && /[a-z0-9_]/i.test(sql[at])) at++;
    } else at++;
    result.push(sql.slice(start, at));
  }
  return result;
}
function shape(input: readonly string[]): BooleanShape {
  let expression = [...input];
  while (expression[0] === '(' && expression.at(-1) === ')') {
    let depth = 0, wrapsAll = true;
    for (let at = 0; at < expression.length - 1; at++) {
      if (expression[at] === '(') depth++;
      if (expression[at] === ')') depth--;
      if (depth === 0) { wrapsAll = false; break; }
    }
    if (!wrapsAll) break;
    expression = expression.slice(1, -1);
  }
  // SQL OR binds less tightly. Preserve AND-vs-OR grouping and all leaf syntax.
  for (const operator of ['OR', 'AND'] as const) {
    let depth = 0, start = 0;
    const parts: string[][] = [];
    for (let at = 0; at < expression.length; at++) {
      if (expression[at] === '(' || expression[at] === '[') depth++;
      if (expression[at] === ')' || expression[at] === ']') depth--;
      if (depth < 0) throw new Error('Unbalanced catalog CHECK');
      if (depth === 0 && expression[at] === operator) { parts.push(expression.slice(start, at)); start = at + 1; }
    }
    if (depth !== 0) throw new Error('Unbalanced catalog CHECK');
    if (!parts.length) continue;
    parts.push(expression.slice(start));
    if (parts.some((part) => !part.length)) throw new Error('Empty catalog CHECK operand');
    const terms = parts.flatMap((part) => {
      const child = shape(part);
      return typeof child !== 'string' && child.operator === operator ? child.terms : [child];
    });
    return { operator, terms };
  }
  return expression.join('');
}
export function restoredConstraintShape(definition: string): BooleanShape {
  if (!definition.startsWith('CHECK ')) return definition;
  return shape(tokens(definition.slice('CHECK '.length)));
}
