---
'@drzl/cli': minor
---

One way to run one generator: `--only <kind>` on `generate` and on `watch`, and one registry behind
all of it.

**`--only <kind>[,<kind>]`, on both commands that can run a generator.** It filters the config's
`generators` list and changes nothing else about the run, so `drzl generate --only zod --check` is a
drift check over one generator's output. The values it accepts are read from the same zod enum the
config parser and the published JSON Schema are built from, so a kind a config accepts is a kind
`--only` accepts, with nothing to keep in step by hand.

**`--schema <path>` on `generate`**, matching `explain -s`: it overrides the config's `schema` and
the drizzle-kit fallback. With `--only` and no config file present, a minimal config is built in
memory, which makes `drzl generate --schema src/db/schema.ts --only orpc` a complete command. It
emits what `drzl generate:orpc src/db/schema.ts` emits, byte for byte, and it works for all fourteen
kinds rather than the two that had a command of their own. Everything the config route offers comes
with it, including `--check`, `--dry-run` and the drift verdicts, none of which the per-kind
commands could reach.

**`watch --pipeline` reaches all fourteen kinds, and no longer fails silently.** It listed seven,
and the other seven matched no dispatch branch at all: `drzl watch --pipeline generate-zod` started,
printed its watch list, and regenerated nothing for as long as it ran, with no error and nothing
wrong with the config. The same was true of `generate-service`, `generate-valibot`,
`generate-arktype`, `generate-typebox`, `generate-effect` and `generate-json-schema`. It is an alias
for `--only` now, mapping `generate-<kind>` to `<kind>`, and `--pipeline analyze` keeps its meaning.
A value that is not a pipeline stops the watcher with a named error instead of leaving it running
and idle, and so does a `--only` value that is not a kind, or a kind this config does not configure.

**`generate:orpc` and `generate:trpc` are deprecated, and go in 5.0.** They keep working, byte for
byte, and print one line on stderr naming the replacement command line. That line goes through the
output layer, so `--quiet` and `--json` both drop it and `drzl generate:orpc --json | jq .` still
parses. Both commands were strictly less capable than the route replacing them: no config at all
meant no table or column filters, no naming, no format, no `importExtension`, no shared validation
schemas, no `databaseInjection`, no drizzle-kit schema resolution, and no write plan, so no
`--check`, no `--dry-run` and no drift verdicts. They also disagreed with each other, since only one
of the two had `--servicesDir`. `generate:orpc` reached its generator through a static import, so an
absent `@drzl/generator-orpc` took the process down with a stack trace before the command ran; it
now names the package to install, like every other kind.

**One registry instead of four dispatch chains.** The fourteen-way `if (g.kind === ...)` chain was
written out in `generate`, in `watch`, and once more in each per-kind command, and every copy
repeated the package name, the `import()`, the constructor, the default output directory and the
options builder. That arrangement has already dropped options in silence more than once: five
validation options never reached a watch rebuild, `servicesDir` reached one command's tRPC branch
and not the other's, and `watch` had no json-schema branch at all for a while. Each generator states
those five facts once now, and adding one is one entry. The emitted tree is byte-identical across
the change: 52 file pairs from a config naming all fourteen kinds, through `generate` and through
`watch`, and 7 more from the two deprecated commands.
