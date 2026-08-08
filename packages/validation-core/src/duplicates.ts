/**
 * A duplicate finder for a batch of rows, emitted beside the schemas.
 *
 * A validator checks one row at a time, so uniqueness is the one constraint it structurally
 * cannot see: whether a value is unique is a fact about the table, not about the row. That is
 * fine for a single insert, where the database answers immediately. It is not fine for a bulk
 * insert, where a batch of a thousand rows fails whole on one collision and the error names a
 * constraint rather than a row.
 *
 * What *is* checkable without the database is whether a batch collides with **itself**, and that
 * is worth checking, because it is the half a user can fix before sending anything.
 *
 * The emitted function is plain TypeScript with no reference to any validation library, so all
 * five generators emit the same thing. It is rendered from one place for that reason.
 */
import type { Key, Table } from '@drzl/analyzer';

/**
 * The constraints worth emitting a finder for: the primary key, then the unique constraints.
 *
 * The primary key belongs here because the database enforces it with a unique index and says so
 * in its own error: two rows sharing an explicit key fail with `duplicate key value violates
 * unique constraint "t_pkey"` (23505, measured on Postgres 17). Seed data is where this bites,
 * since fixtures carry explicit keys so that foreign keys can point at known rows. Rows that
 * leave a generated key to the database are unaffected: absence skips the constraint, exactly as
 * it does for a unique key.
 *
 * The analysis does not record a name for the key, so the finder names it the way the default
 * convention and the constraints module both do: `<table>_pkey`.
 */
function usableKeys(table: Table): Key[] {
  const keys: Key[] = [];
  const pk = table.primaryKey;
  if (pk && pk.columns.length > 0) {
    keys.push({ name: pk.name ?? `${table.name}_pkey`, columns: pk.columns });
  }
  keys.push(...(table.unique ?? []).filter((k) => k.columns.length > 0));
  return keys;
}

/**
 * `findDuplicate<Table>s` for a table with a primary key or unique constraints, or nothing.
 *
 * `rowType` is the name of the insert type, which is what a caller has in hand before an insert.
 * Passed in rather than derived, because each generator names its types differently.
 */
export function renderDuplicateFinder(
  table: Table,
  fnName: string,
  rowType: string
): string | undefined {
  const keys = usableKeys(table);
  if (!keys.length) return undefined;

  const constraints = keys
    .map((k, i) => {
      const name = k.name ?? k.columns.join('_');
      return `  { name: ${JSON.stringify(name)}, columns: ${JSON.stringify(k.columns)} }${
        i === keys.length - 1 ? '' : ','
      }`;
    })
    .join('\n');

  return `/**
 * Rows in \`rows\` that collide with an earlier row on the primary key or a unique constraint.
 *
 * Uniqueness is a fact about the table rather than about a row, so no schema can check it. This
 * checks the half that needs no database: whether the batch collides with itself. A batch that
 * passes here can still collide with rows already stored.
 *
 * A constraint is skipped for any row where one of its columns is null or absent, matching SQL,
 * where NULL is not equal to NULL and a unique index therefore permits repeats. Rows that leave
 * a generated primary key to the database therefore report nothing on it.
 */
export function ${fnName}(
  rows: readonly ${rowType}[]
): Array<{ index: number; constraint: string; firstIndex: number }> {
  const constraints = [
${constraints}
  ] as const;
  const seen = constraints.map(() => new Map<string, number>());
  const out: Array<{ index: number; constraint: string; firstIndex: number }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    for (let c = 0; c < constraints.length; c++) {
      const cols = constraints[c].columns;
      const values = cols.map((col) => row?.[col]);
      if (values.some((v) => v === null || v === undefined)) continue;
      // JSON, so a composite key compares by value and \`[1, "2"]\` never collides with
      // \`["1", 2]\`. A join on a separator would.
      const key = JSON.stringify(values);
      const first = seen[c].get(key);
      if (first === undefined) seen[c].set(key, i);
      else out.push({ index: i, constraint: constraints[c].name, firstIndex: first });
    }
  }
  return out;
}`;
}
