# @drzl/generator-mcp

## 0.1.0

### Minor Changes

- 55b986a: Add `@drzl/generator-mcp`: a Model Context Protocol server generated from a Drizzle schema, one
  tool module per table, with the table's `CHECK` constraints reaching the model as bounds on the
  arguments it is allowed to write.

  An MCP tool hands a model a schema and the model writes arguments against it. Derive that schema
  from the column types alone and the model learns that `age` is an integer and nothing else: it
  guesses a value, the write reaches the database, and the database refuses it. Pointed at DRZL's
  own schemas through `validation.useShared`, the same tool advertises
  `{"type":"integer","minimum":18,"maximum":120}`, and an out-of-range argument is refused before
  the handler runs. A `CHECK` comparing two columns cannot be a keyword in any schema language, so
  those are named in the tool's description instead.

  Five tools per table: `list`, `get`, `create`, `update`, `delete`, each carrying the `readOnlyHint`
  / `destructiveHint` / `idempotentHint` annotations a client reads to decide whether it may call a
  tool without asking first. A table with no primary key keeps `list` and `create`; a materialized
  view keeps `list` and `get`. Plus `index.ts` exporting `createServer()` and a runnable `stdio.ts`.

  `sdk` defaults to `'v2'` (`@modelcontextprotocol/server`), which is the smaller of the two by
  installs and the only one that works for every library DRZL emits: measured on 2026-08-11,
  `@modelcontextprotocol/sdk` types `inputSchema` as zod-only and throws at registration on an
  arktype or valibot schema, so a server built that way dies on startup. `sdk: 'v1'` beside a
  non-zod library is refused at generation time rather than emitted.

  Under valibot the emitted tools wrap each schema in `toStandardJsonSchema` from
  `@valibot/to-json-schema`, because valibot 1.1's `~standard` carries no `jsonSchema` property while
  zod 4's and arktype 2's do. Without the wrapper the tool registers cleanly and advertises no
  arguments at all, which nothing reports.

  `@drzl/cli` gains the `mcp` generator kind, the `sdk`, `serverName`, `serverVersion` and `stdio`
  options, and `naming.toolPrefix`. The new package is an `optionalDependency` for this release only,
  because a package name that has never existed cannot publish through npm trusted publishing and a
  hard dependency on one breaks `npm i @drzl/cli` for everyone until the first publish lands. It is
  promoted once it is on the registry, and `scripts/verify/stages/33-registry-deps.sh` now fails
  when that promotion is due.
