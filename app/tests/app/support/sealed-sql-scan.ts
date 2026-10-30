import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getTableName, is, Table } from 'drizzle-orm';
import { schema, SEALED_COLUMNS } from '@flux/db';

/**
 * F-030 AC-5 SQL source scan: every place in `packages/db/src` where SQL may compute over a sealed column (`WHERE`,
 * `ORDER BY`, `ILIKE`, `char_length`, `ts_headline`, concatenation, a comparison builder such as `eq` or `ilike`). A
 * reference is a Drizzle column (`alias.camelName` or `schema.table.camelName`, the alias bound to a sealed table in
 * the file) or a raw `alias.snake_name` where the file selects `FROM`/`JOIN` that table under that alias. Plain
 * selects, inserts and updates are not computation. Each finding is `file: trimmed line`; the test lists the handled ones.
 */
const BUILDERS = /\b\w+\(sql`\$\{\s*$|\b(?:ilike|notIlike|like|notLike|asc|desc|eq|ne|gt|gte|lt|lte|inArray|notInArray|max|min|countDistinct)\(\s*$/;
/** SQL text right before a column that computes over it: a predicate, an ordering, a function call or an operator. */
const COMPUTE_BEFORE = /(?:\bWHERE|\bAND|\bOR|\bON|\bBY|\bNOT|\bWHEN|\(|\|\||[=<>]|LIKE)\s*(?:\$\{\s*)?$/i;
/** SQL text right after a column that computes over it: a comparison, a pattern match or a concatenation. */
const COMPUTE_AFTER = /^\s*\}?\s*(?:::\w+\s*)?(?:=|<>|!=|<|>|I?LIKE\b|~|\|\||IS\s+(?:NOT\s+)?DISTINCT|IN\s*\()/i;

function sealedColumnsByTable() {
  const out = new Map<string, { camel: Map<string, string>; snake: Set<string> }>();
  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;
    const name = getTableName(value);
    const sealed = SEALED_COLUMNS[name];
    if (!sealed) continue;
    const textColumns = Object.entries(sealed.columns).filter(([, column]) => column.kind !== 'digest').map(([column]) => column);
    const camel = new Map<string, string>();
    for (const [key, column] of Object.entries(value as unknown as Record<string, { name?: string }>)) {
      if (column && typeof column === 'object' && typeof column.name === 'string' && textColumns.includes(column.name)) camel.set(key, column.name);
    }
    out.set(name, { camel, snake: new Set(textColumns) });
  }
  return out;
}

function schemaExports() {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(schema)) if (is(value, Table)) out.set(key, getTableName(value));
  return out;
}

export async function sealedSqlFindings(root = 'packages/db/src') {
  const tables = sealedColumnsByTable();
  const exports = schemaExports();
  const files: string[] = [];
  const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (path.endsWith('.ts')) files.push(path); } };
  await walk(root);
  const findings = new Set<string>();
  for (const file of files.sort()) {
    const text = await readFile(file, 'utf8');
    const drizzleAliases = new Map<string, string>(); // alias -> table
    for (const match of text.matchAll(/\b(\w+)\s*=\s*schema\.(\w+)\b(?!\.)/g)) {
      const table = exports.get(match[2]!); if (table && tables.has(table)) drizzleAliases.set(match[1]!, table);
    }
    for (const [key, table] of exports) if (tables.has(table)) drizzleAliases.set(`schema.${key}`, table);
    const rawAliases = new Map<string, Set<string>>();
    const bind = (alias: string, table: string) => rawAliases.set(alias, (rawAliases.get(alias) ?? new Set()).add(table));
    for (const table of tables.keys()) {
      for (const match of text.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b(?:\\s+(?:AS\\s+)?(\\w+))?`, 'gi'))) {
        const alias = match[1]; bind(table, table);
        if (alias && !/^(WHERE|ON|JOIN|LEFT|INNER|USING|GROUP|ORDER|LIMIT|SET|AND|WITH|RETURNING)$/i.test(alias)) bind(alias, table);
      }
    }
    for (const line of text.split('\n')) {
      for (const [alias, table] of drizzleAliases) {
        for (const [camel] of tables.get(table)!.camel) {
          const pattern = new RegExp(`(?<![\\w.])${alias.replace('.', '\\.')}\\.${camel}\\b`, 'g');
          for (const match of line.matchAll(pattern)) {
            const before = line.slice(0, match.index);
            const after = line.slice(match.index! + match[0].length);
            const interpolated = /\$\{\s*$/.test(before);
            if (BUILDERS.test(before) || (interpolated && (COMPUTE_BEFORE.test(before) || COMPUTE_AFTER.test(after)))) findings.add(`${file}: ${line.trim()}`);
          }
        }
      }
      for (const [alias, bound] of rawAliases) {
        for (const snake of new Set([...bound].flatMap((table) => [...tables.get(table)!.snake]))) {
          for (const match of line.matchAll(new RegExp(`(?<![\\w.$])${alias}\\.${snake}\\b`, 'g'))) {
            const before = line.slice(0, match.index); const after = line.slice(match.index! + match[0].length);
            if (COMPUTE_BEFORE.test(before) || COMPUTE_AFTER.test(after)) findings.add(`${file}: ${line.trim()}`);
          }
        }
      }
    }
  }
  return [...findings];
}
