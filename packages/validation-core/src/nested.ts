/**
 * What a relations-aware nested schema describes, decided once for all five generators.
 *
 * A caller who inserts a parent and its children in one payload, `{ ...user, posts: [...] }`, has
 * nothing to validate it against. Every first-party Drizzle validator emits columns only: measured
 * at drizzle-orm 1.0.0-rc.4 and at the 0.4x `drizzle-zod`/`drizzle-valibot`/`drizzle-typebox`/
 * `drizzle-arktype` packages, `createInsertSchema(users)` yields exactly `['id', 'name']` and never
 * a `posts` key, in every mode and every library. Handing the relations object in as the second
 * argument does not change that either: it lands in the refine slot and is dropped, because its
 * keys are not column names. Handing it in first throws inside `getColumns`.
 *
 * And the payload is not merely unvalidated, it is silently discarded. `db.insert(users).values({
 * name: 'a', posts: [{ title: 't' }] })` emits `insert into "users" ("id", "name") values
 * (default, $1)` on both majors: the relation key is dropped, no error is raised, and the children
 * are simply never written.
 *
 * This module states the *shape* of such a payload from the analysis. It renders nothing: each
 * generator walks the plan and emits it in its own library, so the four cannot disagree about
 * which relations appear or which columns a child carries.
 */
import type { Relation, Table } from '@drzl/analyzer';
import { schemaName, typeName, type NameMode, type ResolvedAffix } from './naming.js';

/**
 * Which modes get a nested variant.
 *
 * `update` is deliberately absent, and it is the one decision here that is a refusal rather than a
 * design. A nested update payload has no single meaning: `{ name: 'x', posts: [...] }` could mean
 * replace every child, upsert them, or patch the ones that match, and choosing needs an operation
 * vocabulary (Prisma spells it `create` / `connect` / `set` / `deleteMany`) that neither DRZL nor
 * Drizzle has. Worse, it could not be acted on even if the meaning were fixed: `updateColumns`
 * drops the primary key, so a child inside an update payload carries nothing that identifies which
 * row it patches. A schema whose meaning the tool emitting it cannot state is worse than no schema.
 */
export type NestedMode = 'insert' | 'select';

/** Prefix in front of the ordinary resolved name, so affixes keep working underneath it. */
export const NESTED_PREFIX = 'Nested';

/** e.g. `NestedInsertusersSchema`. */
export function nestedSchemaName(mode: NestedMode, tsName: string, affix: ResolvedAffix): string {
  return NESTED_PREFIX + schemaName(mode as NameMode, tsName, affix);
}

/** e.g. `NestedInsertusersInput`. */
export function nestedTypeName(mode: NestedMode, tsName: string, affix: ResolvedAffix): string {
  return NESTED_PREFIX + typeName(mode as NameMode, tsName, affix);
}

/**
 * How many levels of children a nested schema describes, when nothing says.
 *
 * One, because one is what the payload in the plan item is: a parent and its children. Deeper is
 * available and is not the default, because the output grows multiplicatively in this number and
 * generated code ships in the consumer's bundle.
 */
export const DEFAULT_NESTED_DEPTH = 1;

/**
 * The most levels `nestedDepth` will honour.
 *
 * Not a taste limit. Nesting is expanded inline rather than by reference, so a schema whose tables
 * average R relations emits R^depth child shapes per root table, and both directions of a
 * many-to-many count. At 3 that is already an eightfold expansion of every column list in the
 * schema; past it the emitted file stops being something a person can open.
 */
export const MAX_NESTED_DEPTH = 3;

/** Clamp a configured depth into the range that is actually emitted, saying so if it moved. */
export function resolveNestedDepth(
  depth: number | undefined,
  warn?: (msg: string) => void
): number {
  if (depth === undefined) return DEFAULT_NESTED_DEPTH;
  if (!Number.isFinite(depth)) return DEFAULT_NESTED_DEPTH;
  const whole = Math.trunc(depth);
  const clamped = Math.min(Math.max(whole, 1), MAX_NESTED_DEPTH);
  if (clamped !== depth && warn) {
    warn(
      `[drzl] nestedDepth ${depth} is outside 1..${MAX_NESTED_DEPTH} and was read as ${clamped}.`
    );
  }
  return clamped;
}

/** One relation as it appears in a payload. */
export interface NestedArm {
  /** The key the payload uses. The child table's Drizzle export name, since nothing else names it. */
  key: string;
  kind: Relation['kind'];
  /** Join table of a many-to-many, carried only so the emitted comment can name it. */
  via?: string;
  /** `true` when the value is one object rather than an array of them. Only a `one` relation. */
  single: boolean;
  /** The child payload, itself possibly carrying relations. */
  child: NestedNode;
  /**
   * Something true about this arm that the shape alone does not say, emitted as a comment beside
   * it. Absent when there is nothing to say.
   */
  note?: string;
}

/** One object in a nested payload: a table, minus what the enclosing parent supplies. */
export interface NestedNode {
  table: Table;
  /**
   * Columns dropped from this object because the row that encloses it supplies them.
   *
   * Always empty at the root and always empty in `select`, where every column of the row really is
   * returned. On `insert` it holds the child's foreign key to its parent; see `armFor`.
   */
  omitted: string[];
  arms: NestedArm[];
}

/**
 * The relation kinds a nested payload of each mode can describe.
 *
 * `one` is absent from `insert`, and that is the second refusal in this file. In
 * `{ ...post, author: {...} }` the foreign key is on the **outer** object, `posts.authorId`, not on
 * the nested one: the author is written first and the post then points at it. So admitting the arm
 * means making `authorId` optional on the post, and an optional `authorId` also admits
 * `{ title: 't' }` with neither a foreign key nor an author, which is a row a NOT NULL column
 * refuses. Adding the arm would therefore make the schema accept a write the database rejects,
 * which is worse than not describing the payload at all.
 *
 * Two forms express it properly and neither is emitted here: a union of "you gave the key" and
 * "you gave the object", which doubles per `one` relation and so is 2^n branches on a table with n
 * of them, or a row-level "exactly one of these" assertion, which all four libraries can carry but
 * each spells differently. Both are open.
 *
 * A `many` arm has no such problem: the omitted foreign key is on the child, so the outer object's
 * own contract is untouched and the nested insert schema stays a strict extension of the plain one.
 */
const KINDS_BY_MODE: Record<NestedMode, ReadonlySet<Relation['kind']>> = {
  insert: new Set(['many', 'manyToMany']),
  select: new Set(['one', 'many', 'manyToMany']),
};

/** Arms are considered in this order, so a pair of tables linked both ways resolves predictably. */
const KIND_ORDER: Record<Relation['kind'], number> = { many: 0, manyToMany: 1, one: 2 };

/**
 * Which of the child's columns the parent supplies, for a `many` arm.
 *
 * The relation states two table names and nothing else, so the columns come from the child's own
 * foreign keys: the ones pointing back at the parent table. Exactly one such key is the case worth
 * acting on.
 *
 * **Zero** means the relation was declared without a real constraint behind it, by `relations()`
 * with no `references`, or by the name-matching heuristic. There is nothing to omit and nothing is
 * wrong; the child simply keeps whatever columns it declared.
 *
 * **More than one** is genuinely ambiguous and is left alone on purpose. A `messages` table with
 * `senderId` and `recipientId` both pointing at `users` has two candidates, and `Relation` carries
 * no field name to tell them apart, so omitting either would silently drop a column the writer has
 * to supply. Omitting both would drop one the parent cannot supply. The arm is still emitted, with
 * both foreign keys present exactly as the plain insert schema has them, and a comment saying why.
 */
function omittedColumnsFor(parent: Table, child: Table): { omitted: string[]; note?: string } {
  const back = (child.foreignKeys ?? []).filter((fk) => fk.foreignTable === parent.name);
  if (back.length === 1) return { omitted: [...back[0].columns] };
  if (back.length === 0) return { omitted: [] };
  const named = back.map((fk) => fk.columns.join('+')).join(', ');
  return {
    omitted: [],
    note:
      `${child.tsName} has ${back.length} foreign keys to ${parent.name} (${named}), so which one ` +
      `this relation uses is not stated. None were omitted: supply them yourself.`,
  };
}

/**
 * The nested payload for one table, expanded `depth` levels.
 *
 * Recursion is bounded rather than expressed. All four libraries can state a cyclic schema, and
 * each does it differently: zod through a property getter, valibot through `v.lazy`, ArkType only
 * inside a `scope` (a plain forward reference throws `Cannot access 'Post' before initialization`
 * at module load), TypeBox only inside a `Type.Module` (a bare `Type.Ref` constructs happily and
 * then throws `Unable to dereference schema with $id` the first time anything checks a value).
 * Every one of those was run.
 *
 * None is used. Expanding inline to a fixed depth needs no recursion API, so no emitted module can
 * throw on import from an unresolvable reference, no zod or valibot schema needs the explicit type
 * annotation a self-referential one demands from TypeScript, and the four outputs stay structurally
 * identical instead of diverging into four different recursion mechanisms. A cycle in the relations
 * simply stops at the depth: `users -> posts -> users` at depth 1 emits the posts and no more.
 */
export function buildNestedPlan(
  root: Table,
  tables: readonly Table[],
  relations: readonly Relation[],
  mode: NestedMode,
  depth: number
): NestedNode | undefined {
  const node = buildNode(root, [], tables, relations, mode, depth);
  // A table with no relations gains nothing from a nested variant: it would be a byte-for-byte
  // copy of the schema beside it under a second name.
  return node.arms.length ? node : undefined;
}

function buildNode(
  table: Table,
  omitted: string[],
  tables: readonly Table[],
  relations: readonly Relation[],
  mode: NestedMode,
  depth: number
): NestedNode {
  if (depth <= 0) return { table, omitted, arms: [] };

  const byDbName = new Map(tables.map((t) => [t.name, t]));
  const allowed = KINDS_BY_MODE[mode];
  // A relation key sits in the same object as the columns, so a column of the same name would be
  // overwritten by it. The columns are the row and win.
  const columnNames = new Set(table.columns.map((c) => c.name));
  const taken = new Set<string>();
  const arms: NestedArm[] = [];

  const candidates = relations
    .filter((r) => r.from === table.name && allowed.has(r.kind))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  for (const rel of candidates) {
    const child = byDbName.get(rel.to);
    if (!child) continue;
    const key = child.tsName;
    if (columnNames.has(key)) continue;
    // Two relations between the same pair of tables produce the same key, because the key can only
    // come from the table name. The first in `KIND_ORDER` wins and the rest are dropped.
    if (taken.has(key)) continue;
    taken.add(key);

    // Only a `many` arm has a foreign key to omit. A `one` arm's nested object is the parent row,
    // which carries none of the child's columns, and a many-to-many keeps both foreign keys on the
    // join table rather than on either end.
    const { omitted: childOmitted, note } =
      rel.kind === 'many' && mode === 'insert'
        ? omittedColumnsFor(table, child)
        : { omitted: [] as string[], note: undefined };

    arms.push({
      key,
      kind: rel.kind,
      via: rel.via,
      single: rel.kind === 'one',
      note,
      child: buildNode(child, childOmitted, tables, relations, mode, depth - 1),
    });
  }

  return { table, omitted, arms };
}

/**
 * The comment lines that go above an arm, without their `//`.
 *
 * Shared so the five generators say the same thing about the same relation, and returned unmarked
 * because each of them indents its object literal differently.
 */
export function nestedArmNotes(arm: NestedArm): string[] {
  const out: string[] = [];
  if (arm.kind === 'manyToMany') {
    out.push(
      `Through ${arm.via ?? 'a join table'}. The join row is not described: its columns are the ` +
        `two foreign keys, and the two ends of this payload supply both.`
    );
  }
  if (arm.note) out.push(arm.note);
  return out;
}

/**
 * Which columns a node contributes, given the mode's column list for its table.
 *
 * The list is passed in rather than derived, so this cannot drift from `insertColumns` and
 * `selectColumns` and so `validation-core`'s entry point stays free of a cycle back into itself.
 */
export function nestedNodeColumns<T extends { name: string }>(
  columnsForMode: readonly T[],
  node: NestedNode
): T[] {
  if (!node.omitted.length) return [...columnsForMode];
  const drop = new Set(node.omitted);
  return columnsForMode.filter((c) => !drop.has(c.name));
}
