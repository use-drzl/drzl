# @drzl/generator-mcp

Generate a [Model Context Protocol](https://modelcontextprotocol.io) server from a Drizzle schema:
one tool module per table, five tools per table, and the table's `CHECK` constraints reaching the
model as bounds on the arguments it is allowed to write.

## The reason this exists

An MCP tool hands a model a schema and the model writes arguments against it. Every other way of
building one of these from a Drizzle schema derives that schema from the column _types_, so the
model learns that `age` is an integer and nothing else. It guesses a value, the write reaches the
database, and the database refuses it.

DRZL parses the table's `CHECK` constraints, so the same tool advertises:

```json
{ "type": "integer", "minimum": 18, "maximum": 120 }
```

and the model never writes the invalid row. A `CHECK` that compares two columns cannot be a
keyword in any schema language, so those are named in the tool's description instead, which is the
only place a model can learn they exist.

## Install

```bash
npm install -D @drzl/generator-mcp
npm install @modelcontextprotocol/server
```

Add it to `drzl.config.ts`:

```ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: './src/validators/zod' },
    {
      kind: 'mcp',
      path: './src/mcp',
      validation: { useShared: true, importPath: 'src/validators/zod' },
    },
  ],
};
```

`useShared` is what carries the constraints. Without it the tool schemas are emitted inline from
the column types alone, which still runs and still validates, but the bounds that make this
generator worth having come from the validation generator's output.

## What it emits

Per table, into `path`:

| Tool             | Arguments                | Annotations                             |
| ---------------- | ------------------------ | --------------------------------------- |
| `users_list`     | `limit`, `offset`        | `readOnlyHint`, `idempotentHint`        |
| `users_get`      | the primary key          | `readOnlyHint`, `idempotentHint`        |
| `users_create`   | the insert schema        | `destructiveHint: false`                |
| `users_update`   | `{ where, data }`        | `idempotentHint`                        |
| `users_delete`   | the primary key          | `destructiveHint`, `idempotentHint`     |

A table with no primary key keeps `list` and `create` and loses the three that address a row. A
materialized view keeps `list` and `get`, because the database refuses every write to one.

Plus `index.ts`, which exports `createServer()` and `registerAllTools(server)`, and `stdio.ts`, a
runnable entry point an MCP client's `command` can point at:

```json
{
  "mcpServers": {
    "shop": { "command": "node", "args": ["./dist/mcp/stdio.js"] }
  }
}
```

The handlers are stubs. `list` and `get` return empty; `create`, `update` and `delete` throw
`Not implemented`. Filling them in is the part only you can write, and the row type each one is
annotated with is a compile error until the shape is right.

## Which SDK

Two generations exist and they are different packages with different rules. Measured on
2026-08-11 by running both:

| | `@modelcontextprotocol/sdk` (v1) | `@modelcontextprotocol/server` (v2) |
| --- | --- | --- |
| zod | works | works |
| arktype | throws at registration | works |
| valibot | throws at registration | works, through `toStandardJsonSchema` |

v1 types `inputSchema` as a zod schema or raw shape, so anything else fails with
`inputSchema must be a Zod schema or raw shape, received an unrecognized object` when the server
starts. v2 takes any Standard Schema that also carries `~standard.jsonSchema`.

`sdk: 'v2'` is the default for that reason. `sdk: 'v1'` is available for a project already on it,
and the generator refuses `v1` with a non-zod library rather than emitting a server that dies on
startup.

Under valibot the emitted tools wrap each schema in `toStandardJsonSchema` from
`@valibot/to-json-schema`, because valibot's `~standard` carries no `jsonSchema` property. Without
the wrapper the tool registers cleanly and advertises no arguments at all, which is a failure
nothing reports.

## Options

| Option          | Default   | What it does                                             |
| --------------- | --------- | -------------------------------------------------------- |
| `path`          | `outDir`  | Where the modules are written                             |
| `sdk`           | `'v2'`    | Which SDK generation the emitted code imports             |
| `serverName`    | `'drzl'`  | The name reported at initialize                           |
| `serverVersion` | `'0.1.0'` | The version reported at initialize                        |
| `stdio`         | `true`    | Also emit the runnable stdio entry point                  |
| `naming.toolPrefix` | none  | Placed in front of every tool name: `db.users_list`       |
| `naming.routerSuffix` | none | Appended to each module name and registrar               |
| `naming.procedureCase` | none | Casing for file names, identifiers and tool-name stems   |

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
