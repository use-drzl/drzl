# Bun and Deno

DRZL is two surfaces, and they fail independently: the code the generators emit, which runs inside
your application, and the `drzl` CLI itself, which runs at build time. This page reports what each
one does under Bun and under Deno, measured rather than assumed.

Measured 2026-08-09 against **Node 22.22.0**, **Bun 1.3.14** and **Deno 2.9.5** (V8 15.0.245.2,
TypeScript 6.0.3), on Linux x64. Bun reports `process.versions.node` as 24.3.0 and Deno as 26.3.0;
neither is Node, and both are listed here because the emitted code and the CLI read that field
through their dependencies.

Everything below ran against the **packed tarballs**, not this repository: all 19 publishable
packages at `@drzl/cli` 4.22.0 were built with `pnpm pack` and installed with `npm` into an empty
project that has none of this repo's `node_modules`. That is the artifact a reader installs, and it
is the only thing worth making a claim about.

Supporting libraries, all at the versions a fresh `npm install` served on the day: `drizzle-orm`
0.45.2, `zod` 4.4.3, `valibot` 1.4.2, `arktype` 2.2.3, `@sinclair/typebox` 0.34.52, `effect` 3.22.1,
`ajv` 8.20.0, `hono` 4.13.1, `@hono/standard-validator` 0.4.0, `@orpc/server` 1.15.0, `@trpc/server`
11.18.0, `express` 5.2.1, `fastify` 5.11.3, `graphql` 17.0.2, `@nestjs/common` 11.1.28.

## The emitted output

Every generator was run over one Postgres schema carrying a serial key, a uuid, a `varchar(20)` with
two CHECK constraints, an integer with a `>= 18` CHECK, a nullable `real`, a boolean with a default,
a `pgEnum`, a `jsonb` and a `timestamp`, plus a second table with a foreign key. The emitted modules
were then **imported and executed**, not merely imported: an import-only check passes against a
module whose runtime behaviour is broken.

Each validator generator was given three values. A valid row must be accepted. A row with a missing
required field and a wrong type must be rejected. A row that is well typed but violates the CHECK
constraint (`age: 5`) must also be rejected, which is what separates "the module loaded" from "the
schema still validates".

| Generator | Bun 1.3.14 | Deno 2.9.5 | What was executed |
| --- | --- | --- | --- |
| `zod` | pass | pass | `safeParse` on all three values |
| `valibot` | pass | pass | `v.safeParse` on all three values |
| `arktype` | pass | pass | the type called directly, `ArkErrors` on failure |
| `typebox` | pass | pass | `Value.Check` on all three values |
| `effect` | pass | pass | the emitted Standard Schema `validate` |
| `json-schema` | pass | pass | compiled and run through `ajv` 8.20.0 |
| `hono` | pass | pass | real requests through `app.request`: list 200, invalid body 400, valid body reaching the handler, bad path param 400 |
| `orpc` | pass | pass | `call()` on `list` and `delete`, and a rejected bad input |
| `trpc` | pass | pass | a server-side caller on `list`, and a rejected bad input |
| `express` | pass | pass | a real listening socket: list 200, invalid body 400 |
| `fastify` | pass | pass | `app.inject`: list 200, invalid body 400 |
| `nestjs` | pass | pass | the emitted `SchemaValidationPipe`, accepting a valid body and answering an invalid one with 400 |
| `graphql` | pass | pass | the emitted SDL compiled by `buildSchema`, including the enum the `pgEnum` produced |
| `service` | pass | pass | the emitted static methods called |

There is one thing you have to configure for Deno, and it is the next section.

## Deno needs an import specifier it accepts

DRZL emits `./authors.zod.js` by default. That spelling is deliberate: it is the only form that
resolves under every `moduleResolution` TypeScript offers, which is why it is the default. Deno does
not accept it, and does not accept the extensionless form either. Measured, with no flags:

```
importExtension: 'js'   (default)  ->  error: Module not found ".../index.js"
importExtension: 'none'            ->  error: Module not found ".../index"
importExtension: 'ts'              ->  runs, 6/6 validator generators pass
```

So pick one of two options, both measured to work:

**Set the extension Deno wants.** As a config excerpt, alongside your existing `generators` list:

```ts
  // resolves natively under Deno, with no flags
  importExtension: 'ts',
```

**Or keep the default and tell Deno to be lenient.** The default `js` output runs unchanged under
`deno run --unstable-sloppy-imports`, which was measured at 6/6 on the same suite.

The tradeoff is real and worth stating, because it is a tradeoff and not a recommendation.
`importExtension: 'ts'` emits `./authors.zod.ts`, and `tsc` rejects a `.ts` import specifier with
`TS5097` unless `allowImportingTsExtensions` is enabled, which itself requires `noEmit` or
`emitDeclarationOnly`. If Deno is the only thing that compiles these files, take `ts`. If the same
files are also built by `tsc` for a Node target, keep the default and pass the Deno flag instead.

Bun resolves all three forms with no configuration.

## The CLI

Nine commands were run under each runtime, against a real Drizzle schema, from the packed install.
All exited 0 everywhere.

| Command | Node 22.22.0 | Bun 1.3.14 | Deno 2.9.5 |
| --- | --- | --- | --- |
| `drzl --version` | pass | pass | pass |
| `drzl --help` | pass | pass | pass |
| `drzl analyze <schema> --json` | pass | pass | pass |
| `drzl doctor` | pass | pass | pass |
| `drzl generate` | pass | pass | pass |
| `drzl generate --check` | pass | pass | pass |
| `drzl generate:orpc <schema>` | pass | pass | pass |
| `drzl generate:trpc <schema>` | pass | pass | pass |
| `drzl init` | pass | pass | pass |

`drzl init` was measured before it gained schema detection and prompts. The work it does now on
these three runtimes is a subset of what `drzl generate` above already does: it imports schema
modules through the same analyzer. The prompts are the only new machinery, they are reached only
when stdin and stdout are both terminals, and the `node:readline/promises` they need is imported
inside that branch and falls back to the non-interactive defaults if a runtime cannot provide it.

The analyzer loads your `drzl.config.ts` and your schema modules through jiti, with
`tryNative: false` so the TypeScript is transformed by jiti rather than by whatever the host runtime
would do with it. That is what makes the three runtimes agree: config loading does not go through
Bun's or Deno's own TypeScript handling. `node:` prefixed imports and `fs.globSync`, a Node 22
built-in the drizzle-kit interop uses to expand `schema` globs, were each checked directly and are
present and working on all three.

## The output is byte-for-byte identical

This is the claim worth making, and it is the one that keeps CI honest: a developer who generates
under Bun and a CI job that checks under Node must not disagree.

Over a config running all 14 generators, the emitted tree is **47 files, identical SHA-256 on all
three runtimes**. `drzl analyze --json`, `drzl doctor`, `--help`, `--version`, the `init` config and
the `generate:orpc` and `generate:trpc` trees are byte-identical too. The only differences anywhere
in the captured output are an elapsed-milliseconds line and absolute paths, neither of which is
written to a file.

Everything in this section is re-measured by `scripts/runtime-compat.sh`, which packs the tarballs,
installs them with npm into an empty project, generates under all three runtimes, compares the bytes
and then executes the emitted schemas under Bun and Deno. Run it against a built tree with
`pnpm build:packages && bash scripts/runtime-compat.sh`.

That property was not free. It cost a defect found while writing this page: under Bun,
`require.resolve` answers a missing package by silently installing it from npm, so a project that
had never depended on Biome would still have its generated files reformatted by it, differently from
Node, from a package downloaded mid-generate. `@drzl/validation-core` now refuses a formatter that
resolves outside the project's own `node_modules`, and resolves each candidate directory
independently because Bun ignores the `paths` list Node honours. A Biome you really did install is
still used, on every runtime.

## Running the CLI without Node installed

`node_modules/.bin/drzl` is an npm bin shim with a `#!/usr/bin/env node` shebang, so on a machine
with no Node on `PATH` it exits 127 before DRZL is reached. That is true of every npm-published CLI
and is not specific to DRZL, but it is worth knowing if your image ships only Bun or only Deno.
Both runtimes can execute the CLI themselves, measured on a `PATH` containing no `node` at all:

```bash
bun x drzl generate
bun node_modules/@drzl/cli/dist/cli.js generate
deno run -A node_modules/@drzl/cli/dist/cli.js generate
```

## What is not claimed

Only the versions named at the top of this page were measured, on Linux x64. Nothing here was run on
Windows or macOS, on Bun or Deno canary, or against Deno Deploy, Cloudflare Workers or any other
hosted runtime; a worker runtime is a different environment from the Deno CLI and this page does not
speak for it. `drzl watch`, which is long-lived and filesystem-event driven, was not exercised under
Bun or Deno.

## Newer runtimes than these

The CI job that keeps this page true pins Bun and Deno to the versions named above, so the page is
exactly true rather than approximately true. A nightly workflow runs the same script against
whatever each project ships that day and records the versions it actually measured, so a regression
in a newer runtime is caught on its own schedule instead of on the next pull request.
