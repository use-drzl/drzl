# MCP server

`@drzl/generator-mcp` emits a [Model Context Protocol](https://modelcontextprotocol.io) server from
your Drizzle schema: one tool module per table, five tools per table, and the table's `CHECK`
constraints reaching the model as bounds on the arguments it is allowed to write.

## Why the constraints matter here more than anywhere else

An MCP tool hands a model a schema and the model writes arguments against it. Derive that schema
from the column types alone, which is what every other route from a Drizzle schema to an MCP server
does, and the model learns that `age` is an integer and nothing else. It guesses a value, the write
reaches the database, and the database refuses it.

DRZL reads the `CHECK` constraints, so given

```ts
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    age: integer('age').notNull(),
  },
  (t) => [check('adult', sql`${t.age} >= 18 AND ${t.age} <= 120`)]
);
```

the `users_create` tool advertises

```json
{
  "type": "object",
  "properties": {
    "email": { "type": "string" },
    "age": { "type": "integer", "minimum": 18, "maximum": 120 }
  },
  "required": ["email", "age"]
}
```

and `{ "age": 7 }` is refused before your handler runs, with a message the model can act on.

A `CHECK` comparing two columns, such as `price > cost`, cannot be a keyword in any schema
language. Those are named in the tool's description instead, which is the only place a model can
learn they exist.

## Setup

```bash
npm install -D @drzl/generator-mcp
npm install @modelcontextprotocol/server
```

```ts
// drzl.config.ts
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

`useShared` is what carries the constraints, and it is worth being explicit about why. Without it
the tool schemas are emitted inline from the column types, which runs and validates but knows
nothing about `CHECK`. The bounds come from the validation generator's output, so the MCP
generator imports them rather than deriving a second, weaker copy.

## What is emitted

Per table:

| Tool           | Arguments         | Annotations                         |
| -------------- | ----------------- | ----------------------------------- |
| `users_list`   | `limit`, `offset` | `readOnlyHint`, `idempotentHint`    |
| `users_get`    | the primary key   | `readOnlyHint`, `idempotentHint`    |
| `users_create` | the insert schema | `destructiveHint: false`            |
| `users_update` | `{ where, data }` | `idempotentHint`                    |
| `users_delete` | the primary key   | `destructiveHint`, `idempotentHint` |

The annotations are not decoration: a client reads `readOnlyHint` to decide it can call a tool
without asking the user first, and `destructiveHint` to decide it must ask. A generator knows which
is which for every table; a person writing these by hand forgets.

A table with no primary key keeps `list` and `create` and loses the three tools that address a
row, because nothing addresses one. A materialized view keeps `list` and `get` and loses every
write, because the database refuses them all.

`update` takes `{ where, data }` rather than a flat object, because the key appears on both sides
otherwise and there is no way to tell "the row I mean" from "the value I am setting".

Plus two files at the top level. `index.ts` exports `createServer()` and
`registerAllTools(server)`; `stdio.ts` is a runnable entry point:

```json
{
  "mcpServers": {
    "shop": { "command": "node", "args": ["./dist/mcp/stdio.js"] }
  }
}
```

The handlers are stubs, like every other DRZL router: `list` and `get` return empty, the three
writes throw `Not implemented`. The row type each read stub is annotated with is a compile error
until the shape you return is right.

## Which SDK, and why the default is the smaller number

Two generations of the TypeScript SDK exist, and they are different packages with different rules.
Measured on 2026-08-11 by registering a tool with each library against each:

|         | `@modelcontextprotocol/sdk` (v1) | `@modelcontextprotocol/server` (v2) |
| ------- | -------------------------------- | ----------------------------------- |
| zod     | works                            | works                               |
| arktype | throws at registration           | works                               |
| valibot | throws at registration           | works, through a wrapper            |

v1 types `inputSchema` as a zod schema or raw shape, so anything else fails with
`inputSchema must be a Zod schema or raw shape, received an unrecognized object` the moment the
server starts. v2 takes any Standard Schema that also carries `~standard.jsonSchema`.

So `sdk: 'v2'` is the default even though v1 has more installs: it is the only one that works for
every library DRZL emits. `sdk: 'v1'` is there for a project already on it, and setting it beside
a non-zod library is refused at generation time rather than producing a server that dies on
startup.

## Valibot needs one extra package

```bash
npm install @valibot/to-json-schema
```

Checked on the same date: zod 4 and arktype 2 both carry `~standard.jsonSchema`, and valibot 1.1
does not. Its `~standard` has `version`, `vendor` and `validate` only. A valibot schema passed
straight to `registerTool` therefore registers cleanly and advertises a tool with **no arguments at
all**, which nothing reports and which no text-level check can see. The emitted tools wrap each
schema in `toStandardJsonSchema`, which is the wrapper the SDK's own documentation names for this.

One further valibot difference, for a `json` or `jsonb` column: the value space DRZL shares with
its other generators uses `v.finite()` and a plain-object guard, and neither survives conversion to
JSON Schema. The MCP generator emits a convertible spelling without them. That is not a weaker
check here, because every argument this server validates has already been through `JSON.parse`, and
`JSON.parse` cannot produce `Infinity`, `NaN` or a class instance in the first place.

## Options

| Option                 | Default   | What it does                                            |
| ---------------------- | --------- | ------------------------------------------------------- |
| `path`                 | `outDir`  | Where the modules are written                            |
| `sdk`                  | `'v2'`    | Which SDK generation the emitted code imports            |
| `serverName`           | `'drzl'`  | The name reported at initialize                          |
| `serverVersion`        | `'0.1.0'` | The version reported at initialize                       |
| `stdio`                | `true`    | Also emit the runnable stdio entry point                 |
| `naming.toolPrefix`    | none      | In front of every tool name: `db.users_list`             |
| `naming.routerSuffix`  | none      | Appended to each module name and registrar               |
| `naming.procedureCase` | none      | Casing for file names, identifiers and tool-name stems   |

`toolPrefix` exists because tool names are one flat namespace per server, unlike the URL trees the
HTTP generators emit. Two schemas on one server need it; one schema does not.

## What it does not do

There is no `outputSchema` on any tool, and that is measured rather than pending. `registerTool`
converts every schema it is handed to JSON Schema, and a row cannot be converted: `z.date()` throws
`Date cannot be represented in JSON Schema`, `z.instanceof(Uint8Array)` throws
`Custom types cannot be represented in JSON Schema`, and arktype and valibot throw their own
equivalents for both. Any table carrying a timestamp, which is nearly all of them, would produce a
server that dies on its first `tools/list`. Results come back as JSON text, which every client
understands.
