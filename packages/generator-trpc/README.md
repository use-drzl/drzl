# @drzl/generator-trpc

Generate [tRPC v11](https://trpc.io) routers from a Drizzle schema, one router per table, wired to
the validation schemas DRZL already generates.

```bash
npm install -D @drzl/generator-trpc
```

`@trpc/server` is the consumer's own dependency; nothing here imports it. This package emits source
text.

## Use it through the CLI

```ts
// drzl.config.ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [{ kind: 'trpc', template: 'standard', includeRelations: true }],
};
```

```bash
drzl generate
```

Or with no config at all:

```bash
drzl generate:trpc src/db/schema.ts -o src/api
```

## What lands on disk

| File | What it is |
| --- | --- |
| `trpc.ts` | the shared base: one `initTRPC` instance, `Context`, `router`, `publicProcedure`, `createCallerFactory` |
| `<table>.ts` | one router per table |
| `index.ts` | `appRouter`, and the `AppRouter` type your client is parameterised by |

```ts
// src/api/users.ts
import { z } from 'zod';
import { publicProcedure, router } from './trpc.js';

export const InsertusersSchema = z.object({ email: z.string() });
export const UpdateusersSchema = z.object({ email: z.string().optional() }).partial();
export const SelectusersSchema = z.object({ id: z.number(), email: z.string() });

export const usersRouter = router({
  list: publicProcedure.output(z.array(SelectusersSchema)).query(async () => {
    return [];
  }),
  byId: publicProcedure
    .input(z.object({ id: z.number() }))
    .output(SelectusersSchema.nullable())
    .query(async ({ input: _input }) => {
      return null;
    }),
  // ... create, update, delete
});
```

Serve it with any tRPC adapter:

```ts
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { appRouter } from './src/api/index.js';

createHTTPServer({ router: appRouter, createContext: () => ({}) }).listen(3000);
```

## Procedures

`list` and `byId` are queries; `create`, `update` and `delete` are mutations. Every procedure
declares an `.output(...)`, which tRPC typechecks the handler's return against.

The primary key is read off your schema, at its real type and with every column of a composite key.
A table with **no** primary key gets only `list` and `create`, rather than a fabricated `id`. A
read-only relation gets only `list` and `byId`.

`includeRelations` adds one `listBy<Column>` query per single-column foreign key.

Use it directly if you prefer:

```ts
import { SchemaAnalyzer } from '@drzl/analyzer';
import { TRPCGenerator } from '@drzl/generator-trpc';

const analysis = await new SchemaAnalyzer('src/db/schema.ts').analyze({ includeRelations: true });
const { files } = await new TRPCGenerator(analysis).generate({ outputDir: 'src/api' });
```

Full documentation: <https://use-drzl.github.io/drzl/generators/trpc>

## Generated Output License

You own the generated output. DRZL grants you a worldwide, royalty-free, irrevocable license to use,
copy, modify, and distribute the generated files under your project's license.

## License

Apache-2.0
