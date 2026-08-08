/**
 * Choosing which *columns* DRZL generates for.
 *
 * `include`/`exclude` answers "which tables". This answers "which columns of them", which the
 * config had no way to say at all. A schema DRZL must read in full still holds columns that should
 * not reach a generated file: a `passwordHash` no client should ever be handed, an internal note
 * column, a `tenantId` the server sets from the session and a request body must not carry. The
 * only previous answer was to edit the emitted file, which the next `drzl generate` overwrites.
 *
 * ## Where this runs
 *
 * On the `Analysis`, once, before any generator is constructed, at the same seam `filterTables`
 * already uses. Not inside `@drzl/analyzer`, which reads a schema module and has no config: `drzl
 * analyze` must keep printing what is really there, and a user asking "what does DRZL see" has to
 * get the truth rather than their own config read back to them. And not inside each generator:
 * there are nine of them plus two template packages, each with its own idea of a mode, and the one
 * that forgot would emit a schema silently wider than the config asked for. Narrowing the analysis
 * is also what keeps the validators, the OpenAPI document, the emitted `.meta()` facts and the
 * service layer describing the same columns, since all of them read this one object.
 *
 * ## Why the narrowing is more than `columns`
 *
 * A table states its columns twice: once as `columns`, and again by name in `primaryKey`,
 * `unique`, `indexes`, `foreignKeys` and `checks`. Dropping a column from the first list and
 * leaving the others is not a smaller schema, it is an inconsistent one, and each stale name has a
 * different consequence:
 *
 * - `unique` reaches emitted TypeScript verbatim. `findDuplicate<Table>` declares
 *   `columns: ["email"]` against the insert row type, so a unique key naming a column that type no
 *   longer has is a generated file that does not compile. Narrowed.
 * - `foreignKeys` drives the relation lookup procedures in the tRPC and oRPC generators, both of
 *   which already resolve the column against `columns` and skip when it is gone. Narrowed, which
 *   changes no output and stops the analysis asserting a key over a column it does not have.
 * - `indexes` is read by nothing today. Narrowed anyway, on the same grounds.
 * - `checks` is deliberately *not* narrowed. Every generator already drops a row check naming a
 *   column the mode does not carry, so nothing breaks, and the constraint really does still exist
 *   in the database: leaving it lets `meta` keep listing it as unenforced, which is the honest
 *   answer. A warning says so.
 * - `primaryKey` cannot be narrowed, because omitting a key column is refused outright. See below.
 */
import type { Table } from '@drzl/analyzer';
import { parseCheck } from '@drzl/validation-core';
import { namedColumns } from './doctor.js';
import {
  addressableName,
  ambiguousPatternWarnings,
  displayTableName,
  hasNamedSchemas,
  matchesAny,
  matchesTable,
} from './patterns.js';

/** What to do with one table's columns. Both are patterns, in the language `patterns.ts` defines. */
export interface ColumnRules {
  /** Drop these. Applied after `pick`, so it wins where both name the same column. */
  omit?: string[];
  /** Keep only these. */
  pick?: string[];
}

/**
 * Keyed by table pattern, matched against the database table name exactly as `include` is, and
 * against the schema-qualified name too: `reporting.users` names one of two same-named tables and
 * `reporting.*` names a whole schema.
 */
export type ColumnFilter = Record<string, ColumnRules>;

export interface ColumnFilterResult {
  tables: Table[];
  /** Printed by the caller. Nothing here stops generation. */
  warnings: string[];
}

/** Every column name a CHECK talks about, whatever kind of constraint it turned out to be. */
function checkedColumns(expression: string | undefined, name: string | undefined): string[] {
  const parsed = parseCheck(expression, name);
  if (!parsed.ok) return [];
  return [...new Set(namedColumns(parsed).map((n) => n.column))];
}

/**
 * Narrow every table's columns to what the config asked for.
 *
 * Throws on anything that cannot be honoured, with every such problem in one message: a config is
 * edited once and rerun, and reporting the first of four typos three times is three wasted runs.
 * Returns warnings for what *is* honoured but changes what the output can do.
 *
 * Call this **before** `filterTables`. Both orders produce the same tables, since one narrows
 * columns and the other drops whole tables, but only this order lets a `columns` entry name a
 * table that `exclude` also removes without that reading as a typo.
 */
export function filterColumns(tables: Table[], spec: ColumnFilter | undefined): ColumnFilterResult {
  const entries = Object.entries(spec ?? {});
  if (!entries.length) return { tables, warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];
  // Only where the analysis really has more than one schema. A project with one has no `public.`
  // to write, so offering it as the spelling to copy names something its schema file never says.
  const nameForConfig = hasNamedSchemas(tables) ? addressableName : displayTableName;

  /**
   * Every pattern has to name something that exists.
   *
   * This is the loud half, and it is the reason the option is safe to reach for. `omit:
   * ['passwrodHash']` that silently does nothing is not a no-op: it is the leak the option was
   * reached for, wearing the shape of a fix, and nothing downstream can tell the difference
   * between a column that was never there and one that was already dropped.
   *
   * A column pattern is required to match in *at least one* of the tables its entry matched, not
   * in all of them. Requiring all would make a wildcard table key useless, and dropping
   * `deleted_at` from every `app_*` table that has one is the main thing a wildcard key is for.
   */
  for (const [tablePattern, rules] of entries) {
    const matched = tables.filter((t) => matchesTable([tablePattern], t));
    if (!matched.length) {
      errors.push(
        `columns[${JSON.stringify(tablePattern)}] matches no table. ` +
          `The schema declares: ${tables.map(nameForConfig).join(', ') || '(no tables)'}.`
      );
      continue;
    }
    const available = [...new Set(matched.flatMap((t) => t.columns.map((c) => c.name)))];
    for (const which of ['pick', 'omit'] as const) {
      for (const pattern of rules[which] ?? []) {
        if (available.some((name) => matchesAny([pattern], name))) continue;
        errors.push(
          `columns[${JSON.stringify(tablePattern)}].${which} names ${JSON.stringify(pattern)}, ` +
            `which matches no column of ${matched.map(nameForConfig).join(', ')}. ` +
            `Available: ${available.join(', ')}.`
        );
      }
    }
  }

  // Said once per pattern, before anything is narrowed, because the consequence is that the rules
  // below run over more tables than the writer had in mind and every one of them is a real table.
  warnings.push(
    ...ambiguousPatternWarnings(
      entries.map(([p]) => p),
      tables,
      'columns'
    )
  );

  const out = tables.map((table) => {
    const mine = entries.filter(([pattern]) => matchesTable([pattern], table));
    if (!mine.length) return table;

    // Applied in the order the entries are written, so a reader works down the config the way they
    // read it. Within one entry `pick` narrows and then `omit` removes, which is the same
    // precedence `exclude` already has over `include`: the direction that takes something away
    // wins, because that is the safe direction for the thing this option exists to remove.
    let keep = table.columns;
    for (const [, rules] of mine) {
      if (rules.pick?.length) keep = keep.filter((c) => matchesAny(rules.pick!, c.name));
      if (rules.omit?.length) keep = keep.filter((c) => !matchesAny(rules.omit!, c.name));
    }
    if (keep.length === table.columns.length) return table;

    const kept = new Set(keep.map((c) => c.name));
    const dropped = table.columns.filter((c) => !kept.has(c.name));

    if (!keep.length) {
      errors.push(
        `columns leaves table "${displayTableName(table)}" with no columns at all. An empty schema describes ` +
          `no row, so this is never a narrower API. Exclude the table instead, with the top-level ` +
          `"exclude" option.`
      );
      return table;
    }

    /**
     * A primary key column is refused rather than narrowed, and it is the one hard no here.
     *
     * The key is what addresses a row, and every generator that addresses one reads it
     * differently, so the consequence of dropping it depends on which generators happen to be
     * configured: the tRPC generator resolves the key against `columns` and silently drops byId,
     * update and delete; the oRPC generator never reads the key at all and keeps emitting
     * procedures typed `{ id: number }`; the service generator falls back to a column literally
     * named `id` and emits `eq(users.id, id)`, which does not compile when the key was called
     * something else; the OpenAPI document drops its `/{id}` paths; and zod's `meta` would publish
     * a primary key whose column the schema no longer describes. One config, five outcomes, none
     * of them announced.
     *
     * Refusing is also the reversible direction. An error can be relaxed to a warning later
     * without breaking a config that works; a warning cannot be tightened into an error without
     * breaking one.
     */
    const lostKey = (table.primaryKey?.columns ?? []).filter((n) => !kept.has(n));
    if (lostKey.length) {
      errors.push(
        `columns drops ${lostKey.map((n) => JSON.stringify(n)).join(', ')} from table ` +
          `"${displayTableName(table)}", which is part of its primary key ` +
          `(${table.primaryKey?.columns.join(', ')}). The generated getById, update and delete ` +
          `address rows by that key, so the emitted schemas would describe a row nothing can ` +
          `address. Keep the key, or leave the whole table out with the top-level "exclude" option.`
      );
      return table;
    }

    /**
     * A NOT NULL column with no default is warned about and then dropped, which is the other half
     * of the same judgement.
     *
     * It really does produce an insert schema that cannot describe a whole row. It is also the
     * multi-tenant pattern: a NOT NULL `tenantId` the server takes from the session is exactly a
     * column a request body must not carry, and refusing it would remove one of the two things
     * this option is for. An insert schema describes a request, not a row, so the narrower
     * statement is true; what is not obvious is who then supplies the rest, and that is what the
     * warning says. If a generated service in `drizzle` mode is handed the narrowed body, its
     * `create` parameter is Drizzle's own `$inferInsert` and the missing column is a compile error
     * in the generated project, which is loud on its own.
     */
    for (const c of dropped) {
      if (c.nullable || c.hasDefault || c.isGenerated || table.readOnly) continue;
      warnings.push(
        `drzl config: the "columns" option drops "${c.name}" from table "${displayTableName(table)}", and the ` +
          `database requires it: NOT NULL with no default. The emitted insert schema therefore ` +
          `describes a payload that is not a complete row, so whatever calls db.insert has to ` +
          `supply "${c.name}" itself.`
      );
    }

    // A CHECK naming a dropped column stops being enforced by anything DRZL emits. The generators
    // already skip it rather than emitting a comparison against a field that is not there, so this
    // is a warning and not an error, but it is exactly the silent kind of loss `drzl doctor` was
    // written for.
    for (const k of table.checks ?? []) {
      // Only names this filter really took away. A CHECK naming a column the table never had is a
      // different finding with a section of its own in `drzl doctor`, and claiming it here would
      // blame the config for something that was already wrong.
      const lost = checkedColumns(k.expression, k.name).filter(
        (n) => !kept.has(n) && table.columns.some((c) => c.name === n)
      );
      if (!lost.length) continue;
      warnings.push(
        `drzl config: CHECK ${k.name ? `"${k.name}"` : '(unnamed)'} on table "${displayTableName(table)}" ` +
          `names ${lost.map((n) => JSON.stringify(n)).join(', ')}, which the "columns" option ` +
          `drops, so nothing DRZL emits enforces it. Your database still does.`
      );
    }

    return {
      ...table,
      columns: keep,
      unique: (table.unique ?? []).filter((k) => k.columns.every((n) => kept.has(n))),
      indexes: (table.indexes ?? []).filter((i) => i.columns.every((n) => kept.has(n))),
      ...(table.foreignKeys
        ? { foreignKeys: table.foreignKeys.filter((f) => f.columns.every((n) => kept.has(n))) }
        : {}),
    };
  });

  if (errors.length) {
    throw new Error(
      `drzl config: the "columns" option cannot be honoured.\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }

  return { tables: out, warnings };
}
