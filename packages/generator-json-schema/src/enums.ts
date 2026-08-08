/**
 * Shared enums, written once and referenced.
 *
 * A `mood` enum on six columns used to be six copies of the same list, in every schema of every
 * mode. JSON Schema has had a way to say this since forever and the generator was not using it.
 *
 * **Where the definition goes depends on the document, and the two answers are not interchangeable.**
 * Measured against `@seriousme/openapi-schema-validator`, which carries the real 3.0 and 3.1
 * meta-schemas:
 *
 *   | placement                                   | 3.0       | 3.1                        |
 *   | ------------------------------------------- | --------- | -------------------------- |
 *   | `components.schemas` + `#/components/...`    | valid     | valid                      |
 *   | `$defs` inside a schema + `#/$defs/...`      | INVALID   | INVALID, `$ref` unresolved |
 *
 * 3.0's Schema Object is closed, so `$defs` beside `properties` is an unknown keyword and the whole
 * document fails. 3.1 allows the keyword and still fails, because a `$ref` in a document resolves
 * against the *document* root: `#/$defs/mood` names nothing there. So a document shares through
 * `components.schemas` whichever version it is, and `$defs` is only for the standalone per-table
 * modules, which are real JSON Schema documents with a `$schema` and an `$id` of their own.
 *
 * **Only shared enums.** An enum used once gains nothing from the indirection: the reference object
 * is about as long as the list it replaces, and a reader now has to resolve it to learn anything.
 * Two uses is where the arithmetic turns, and it is measured rather than assumed in
 * `test/shared-enums.spec.ts`.
 *
 * **Only declared enums.** A `CHECK (status IN ('a','b'))` also renders as an `enum` and is left
 * inline. It is a constraint on one column rather than a named type, and two columns whose IN lists
 * happen to agree are two constraints, not one type: giving them a shared name would invent a
 * concept the schema never declared, and the name would have to be invented too.
 *
 * **A reference is used only where it is the whole schema for the column.** `$ref` in OpenAPI 3.0
 * is defined to make every sibling key be ignored, so `{ $ref, nullable: true }` is a schema that
 * silently refuses null, and `{ $ref, default: 'x' }` is a default no reader sees. 2020-12 and 3.1
 * both have an unambiguous spelling for the nullable case, `anyOf: [{ $ref }, { type: 'null' }]`,
 * which validates; the same shape in a 3.0 document does not, because `type: 'null'` is not one of
 * that version's six types. So a nullable enum column in a 3.0 document keeps the inline enum it
 * has always had, and the shared definition still serves every other use of the same enum.
 */
import type { Column, Enum, Table } from '@drzl/analyzer';

/** A `$ref` for a column carrying exactly these values, or nothing to leave the enum inline. */
export type EnumRefResolver = (values: readonly string[]) => string | undefined;

/** What a set of shared enums resolved to, plus the definitions the document has to carry. */
export interface EnumPlan {
  /** Hand to `tableSchemas`; records each hit so `definitions` holds only what was referenced. */
  resolve: EnumRefResolver;
  /** The definitions actually referenced, keyed by the name they are published under. */
  definitions(): Record<string, { enum: string[] }>;
}

/** Values as a key, so two columns declaring the same list are one enum. */
const identity = (values: readonly string[]) => JSON.stringify([...values]);

/**
 * A component or `$defs` key derived from the enum's own name.
 *
 * OpenAPI constrains a `components.schemas` key to `^[a-zA-Z0-9.\-_]+$`, measured: a key holding a
 * space, a slash or a non-ASCII letter each made the document invalid or the `$ref` unresolvable.
 * `$defs` has no such rule, and the same spelling is used for both so one enum has one name
 * wherever it is published.
 *
 * A name that survives sanitising as nothing at all is refused rather than replaced with a
 * generated one: the enum then stays inline, which is what it did before any of this existed.
 */
export function enumKey(name: string): string | undefined {
  const safe = name.replace(/[^A-Za-z0-9.\-_]/g, '_').replace(/^_+|_+$/g, '');
  return safe.length ? safe : undefined;
}

/** Every column that would render as a declared enum, across these columns. */
function declaredEnumColumns(columns: Column[]): Column[] {
  // Not `c.enumValues` alone. A column the parser narrowed to a set of literals renders as that set
  // instead, and a structured column never reaches the enum branch at all, so counting either
  // would call an enum shared on the strength of a use that does not exist.
  return columns.filter((c) => !c.shape && c.enumValues && c.enumValues.length);
}

/**
 * The enums used by two or more of these columns, as a plan.
 *
 * `enums` is the analysis's own list, which is where the *name* comes from: a column carries its
 * values and nothing else, and `mood` is a better key than anything derivable from `['sad','ok']`.
 * An enum the analysis does not name is left inline rather than given an invented name.
 */
export function planSharedEnums(
  columns: Column[],
  enums: Enum[] | undefined,
  ref: (key: string) => string,
  reserved: ReadonlySet<string> = new Set()
): EnumPlan | undefined {
  if (!enums?.length) return undefined;

  const uses = new Map<string, number>();
  for (const c of declaredEnumColumns(columns)) {
    const id = identity(c.enumValues!);
    uses.set(id, (uses.get(id) ?? 0) + 1);
  }

  const keyed = new Map<string, { key: string; values: string[] }>();
  const taken = new Set(reserved);
  for (const e of enums) {
    const id = identity(e.values);
    if ((uses.get(id) ?? 0) < 2) continue;
    if (keyed.has(id)) continue;
    const key = enumKey(e.name);
    // A key already claimed by a table's schema is left alone rather than disambiguated. The
    // alternative is a suffixed name that changes the moment a table is added, and an enum that
    // stays inline is exactly what every enum did before.
    if (!key || taken.has(key)) continue;
    taken.add(key);
    keyed.set(id, { key, values: [...e.values] });
  }
  if (!keyed.size) return undefined;

  const used = new Set<string>();
  return {
    resolve(values) {
      const hit = keyed.get(identity(values));
      if (!hit) return undefined;
      used.add(hit.key);
      return ref(hit.key);
    },
    definitions() {
      const out: Record<string, { enum: string[] }> = {};
      for (const { key, values } of keyed.values()) {
        if (used.has(key)) out[key] = { enum: [...values] };
      }
      return out;
    },
  };
}

/** Every column of every table, which is the scope a whole document shares over. */
export const allColumns = (tables: Table[]): Column[] => tables.flatMap((t) => t.columns);
