# @drzl/generator-ai

Generate [Vercel AI SDK](https://ai-sdk.dev) tools from a Drizzle schema: five tools per table, with
the table's `CHECK` constraints reaching the model as bounds on the arguments it is allowed to send.

## The reason this exists

A tool hands a model a JSON Schema and the model writes arguments against it. Derive that schema
from the column types alone and the model learns that `age` is an integer and nothing else: it
guesses, the write reaches the database, and the database refuses it. Pointed at DRZL's own schemas
the same tool advertises `{ "type": "integer", "minimum": 18, "maximum": 120 }` and the invalid call
never happens.

## One measurement changed what this emits

`tool()` accepts any Standard Schema, and the SDK's adapter decides whether a validation passed with
`'value' in result`. A valibot failure result is `{ value, typed, issues }`: it carries a `value` key
even when it failed. So every valibot validation failure is reported to the AI SDK as a **success**
and the invalid input reaches `execute`.

Measured on 2026-08-11 against `ai` 7.0.59 and `@ai-sdk/provider-utils` 5.0.26, with a schema
demanding `age >= 18`: zod and arktype refuse `{ age: 7 }` through the SDK, valibot accepts it.
Their failure results carry no `value` key and valibot's does.

A generated valibot tool handed over as a Standard Schema would validate nothing at all, silently.
So valibot tools are emitted through `jsonSchema(document, { validate })` with the parse spelled
out; zod and arktype are passed through, because they work.

## Install

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

`useShared` is what carries the constraints. Valibot needs `@valibot/to-json-schema` as well, for
the adapter above.

## Using them

```ts
import { generateText } from 'ai';
import { allTools } from './ai/tools';

await generateText({ model, tools: allTools, prompt: 'Add a user called Omar who is 30.' });
```

`allTools` is one flat object, which is what `generateText` and `streamText` take. Each table also
exports its own set.

Full documentation: https://use-drzl.github.io/drzl/generators/ai

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
