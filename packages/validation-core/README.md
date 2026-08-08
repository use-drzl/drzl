<div align="center">

# @drzl/validation-core

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fvalidation-core)](https://www.npmjs.com/package/@drzl/validation-core)

</div>

Shared interfaces and helpers used by validation generators.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Exports (essentials)

- ValidationLibrary: `'zod' | 'valibot' | 'arktype' | 'typebox'`
- ValidationRenderer<TOptions>
  - `library`
  - `renderTable(table, opts)`
  - `renderIndex?(analysis, opts)`
- Helpers
  - `insertColumns(table)`, `updateColumns(table)`, `selectColumns(table)`
  - `formatCode(code, filePath, formatOpts)`
- File names (shared by every generator that writes a file and a barrel)
  - `moduleFileName(tsName, fileSuffix)` -> `users.zod.ts`
  - `moduleSpecifier(tsName, fileSuffix, importExtension?)` -> `./users.zod.js`, the
    specifier a sibling module needs to import that file.
  - `importSpecifier(relativePath, importExtension?)` does the same for a path a generator
    already has in hand, e.g. `./types/users.ts` -> `./types/users.js`.
  - Both read the same `fileSuffix`, so a barrel can never name a file that was not written.
  - `ImportExtension` is `'js' | 'none' | 'ts'`, defaulting to `DEFAULT_IMPORT_EXTENSION`
    (`'js'`). `'js'` is the only form that resolves under `bundler`, `node10`, `node16` and
    `nodenext`, in both CommonJS and ESM, with no compiler flag. `'none'` is the pre-2.0
    output and misses `node16`/`nodenext` ES modules. `'ts'` needs
    `allowImportingTsExtensions`. `.mts` and `.cts` become `.mjs` and `.cjs` under both
    `'js'` and `'none'`, since an extensionless specifier never resolves to them.
- CHECK constraints (shared by every generator that reads them)
  - `parseCheck(expression, name)` -> the parts of a `CHECK` that can be stated with certainty:
    column comparisons, `BETWEEN`, `IN (...)`, top-level `AND`, `length()`/`char_length()`,
    `octet_length()`, `cardinality()`/`array_length(col, 1)`, and comparisons between two columns.
    A negation, an unrecognised function call and a regex match are all refused whole rather than
    half-applied, and a disjunction is read only where the whole of it pins one column to a set.
  - `lengthMeasure(column, check)` -> how to answer a count on a given column, as one of
    `'codePoints'`, `'utf8Bytes'` or `'byteLength'`, or nothing where no expression answers it.
    The unit is on the check and the answer needs the column too: measured on PostgreSQL 17.5,
    `length()` is the character count on a `text` and the byte count on a `bytea`, and
    `char_length(bytea)` is not a function that exists. `measureExpression(measure, variable)`
    renders it and `lengthCheckLabel(check)` renders the message the ledger keys on.
  - `COLUMN_FORMATS` -> patterns for the column formats that are expressible. Only `numeric` is:
    Postgres accepts `today`, `January 8, 1999` and `allballs`, so a date or time pattern would
    reject rows the database takes.
  - `CODEPOINT_LENGTH` -> `[...v].length`, since `varchar(n)` counts characters and JavaScript's
    `.length` counts UTF-16 units. All four generators use it.
  - `isIntegerColumn(c)`
- Constraints as data (shared by the generators that emit a ledger)
  - `tableConstraints(table)` -> every CHECK, unique constraint, primary key and foreign key on a
    table, each with a stable `id`, the columns it names, the rule as a sentence, whether a
    generated schema enforces it, and, where it does, the exact message it attaches. A folded
    numeric CHECK carries its `bounds` and a folded `IN` list its `values`, because those are what
    is left to match on once the library writes the failure message itself.
  - `classifyTableChecks(table)` -> the one reading of `parseCheck` plus the column-shape guards,
    shared with `meta`, so "the database also checks this and no schema does" is one answer rather
    than two.
  - `renderConstraintsModule(tables, opts)` -> the source of `constraints.ts`: the data above plus,
    unless `errorMap` is false, `constraintForIssue(table, issue)`. Plain objects with no import of
    any kind, and the matcher reads zod's path items and valibot's alike.
  - `resolveConstraints(option)` expands the `true` shorthand; `CONSTRAINTS_MODULE` is the file
    name every generator writes it to.
- Uniqueness
  - `renderDuplicateFinder(table, fnName, rowType)` -> the source of a function returning the rows
    in a batch that collide with an earlier row on the primary key or a unique constraint. Plain
    TypeScript with no reference to any validation library, so every validator generator emits the
    same one. Null and absent columns skip a constraint, matching SQL, so rows that leave a
    generated key to the database report nothing on it.
- Naming (shared by every generator that emits a schema name)
  - `resolveAffix({ affix, schemaSuffix })` -> `ResolvedAffix`
  - `schemaName(mode, tsName, resolved)`, `typeName(mode, tsName, resolved)`
  - `validateAffix(affix, schemaSuffix)` -> issues for unusable or colliding names
  - `pascalCase(s)`, `applyTableCase(tsName, 'preserve' | 'pascal')`
  - Calling `resolveAffix()` with no options reproduces the original naming exactly, so the
    generators and the oRPC router can never interpret one config two ways.
