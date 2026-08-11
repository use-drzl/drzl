# AI SDK tools

`@drzl/generator-ai` emits a [Vercel AI SDK](https://ai-sdk.dev) `ToolSet` from your Drizzle schema:
five tools per table, with the table's `CHECK` constraints reaching the model as bounds on the
arguments it is allowed to send.

## The same thesis as MCP, a different surface

A tool hands a model a JSON Schema and the model writes arguments against it. Derive that schema
from the column types alone and the model learns that `age` is an integer and nothing else: it
guesses, the write reaches the database, and the database refuses it. Pointed at DRZL's own schemas
through `validation.useShared`, the same tool advertises `{"type":"integer","minimum":18,"maximum":120}`
and the invalid call never happens.

See [MCP](/generators/mcp) for the same story over the Model Context Protocol. The two share their
description generation and their input-schema rules; what differs is the surface a model reaches
them through.

## One measurement changed what this emits

`tool()` accepts any Standard Schema, and the SDK's adapter decides whether a validation passed
with `'value' in result`. **A valibot failure result is `{ value, typed, issues }`: it carries a
`value` key even when it failed.** So every valibot validation failure is reported to the AI SDK as
a success and the invalid input reaches `execute`.

Measured on 2026-08-11 against `ai` 7.0.59 and `@ai-sdk/provider-utils` 5.0.26, with a schema
demanding `age >= 18`:

| Library | `v.safeParse` / `.safeParse` directly | Through the AI SDK |
| ------- | ------------------------------------- | ------------------ |
| zod     | refuses `{ age: 7 }`                  | refuses            |
| arktype | refuses `{ age: 7 }`                  | refuses            |
| valibot | refuses `{ age: 7 }`                  | **accepts**        |

zod's failure result is `{ issues }` and arktype's is an `ArkErrors` array; neither has a `value`
key, so both work. A generated valibot tool handed over as a Standard Schema would validate nothing
at all, silently, and would look identical to one that worked in the emitted text and in a type
check.

So valibot tools are emitted through `jsonSchema(document, { validate })` with the parse spelled
out. zod and arktype are passed through, because they work.

## Setup

```bash
npm install -D @drzl/generator-ai
npm install ai
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [
    { kind: 'zod', path: 'src/validators/zod' },
    {
      kind: 'ai',
      path: 'src/ai/tools',
      validation: { useShared: true, importPath: 'src/validators/zod' },
    },
  ],
};
```

`useShared` is what carries the constraints. Without it the tool schemas are emitted inline from
the column types, which runs and validates but knows nothing about `CHECK`.

Valibot needs one more package, for the adapter above:

```bash
npm install @valibot/to-json-schema
```

## Using them

```ts
import { generateText } from 'ai';
import { allTools } from './ai/tools';

const result = await generateText({
  model,
  tools: allTools,
  prompt: 'Add a user called Omar who is 30.',
});
```

`allTools` is one flat object, which is what `generateText` and `streamText` take. Each table also
exports its own set, so a smaller surface is a spread away:

```ts
import { usersTools } from './ai/tools/users';
```

## What is emitted

Per table: `users_list`, `users_get`, `users_create`, `users_update` and `users_delete`. A table
with no primary key keeps `list` and `create`. A materialized view keeps `list` and `get`, because
the database refuses every write to it.

`update` takes `{ where, data }` rather than a flat object, because the key would otherwise appear
on both sides with no way to tell "the row I mean" from "the value I am setting".

Every `execute` is a stub and every one carries an explicit return type. That is not decoration: a
stub whose only statement is `throw` returns `Promise<never>`, and `never` propagates into `tool()`'s
inference until the call matches no overload at all, reporting a problem about the *input* schema
for something entirely about the output.

A `CHECK` comparing two columns cannot be a keyword in any schema language, so those are named in
the tool's description instead.

## Tool names

Letters, digits, underscore and dash. Narrower than MCP's own SEP-986 set, which also allows a dot,
because a tool name here becomes a function name in a provider's request and a name a provider
rejects fails the whole call rather than the one tool. Use `naming.toolPrefix` when one tool set
carries two schemas.

## Options

| Option                 | Default  | What it does                                          |
| ---------------------- | -------- | ------------------------------------------------------ |
| `path`                 | `outDir` | Where the modules are written                          |
| `validation.library`   | `zod`    | Which library the emitted schemas are written in        |
| `validation.useShared` | off      | Import a sibling generator's constrained schemas        |
| `naming.toolPrefix`    | none     | In front of every tool name: `db_users_list`            |
| `naming.routerSuffix`  | none     | Appended to each module name and tool-set identifier    |
| `naming.procedureCase` | none     | Casing for file names, identifiers and tool-name stems  |
