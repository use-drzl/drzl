echo "==> generating the parity matrix from every dialect"
# What DRZL claims is that every difference between its generated schemas and the first-party
# `drizzle-orm/{zod,valibot,arktype,typebox}` modules is known and named. Not that it is at least as
# strict: this comment said that for a long time and it was never true, since Postgres takes three
# emoji into a `char(3)` and a Uint8Array into a `bytea` and official refuses both. Where the two
# disagree the database decides which is right, and the answer goes in ALLOWED with its
# measurement.
#
# That is a claim about behaviour, so it is measured by behaviour: generate for the same table,
# then push the same pool of values through both schemas column by column and compare the verdicts.
# Reading the emitted source cannot do this, because a schema that parses and a schema that
# validates look identical as text.
#
# Three dialects and all three modes, because the gaps cluster in the corners: MySQL owns the
# narrow integer widths and the text/blob caps, SQLite owns the blob modes, and insert and update
# own optionality and the generated-column rules.
#
# It runs here, against the packed tarballs, rather than as a unit test, because it needs
# drizzle-orm v1 and the workspace is still on 0.4x. Installing v1 into this throwaway tree keeps
# it out of the repo's own dependency graph.
PARITY="$WORK/parity"
mkdir -p "$PARITY/src"
cd "$PARITY"
echo '{ "name": "parity", "private": true, "type": "module" }' > package.json

cp "$FIXTURES/parity-pg.schema.ts" src/schema.ts
cp "$FIXTURES/parity-mysql.schema.ts" src/schema-mysql.ts

cp "$FIXTURES/parity-sqlite.schema.ts" src/schema-sqlite.ts

# The value pool and the per-library accessors, in a file of their own because two trees push the
# same values now: this one, pinned to drizzle-orm v1, and the 0.4x tree near the end of this
# gate. Copied rather than shared through a path, since the two trees have separate
# node_modules and one of them is CommonJS.
#
# Written once so the two passes cannot drift. A pool value added for one major has to be answered
# by the other, and the point of the 0.4x pass is that a difference between the two is a defect
# rather than a difference in what was asked.
cp "$HARNESS/parity-pool.ts" src/pool.ts

cp "$HARNESS/parity.ts" src/parity.ts

# drizzle-orm is pinned: the parity target is a specific release, and a floating one would turn
# an upstream change into a mysterious failure here rather than a deliberate re-measurement.
#
# ajv and ajv-formats are the JSON Schema generator's own declared devDependency ranges, so the
# packed artefact is read by the same validator its unit tests claim it is checked against. They
# are not dependencies of anything DRZL publishes: JSON Schema output is data with no runtime.
#
# typescript, because this tree's generated output is now compiled as well as executed. It was
# only ever run, and a nullable bigint array reached a released generator emitting `>=` against a
# `bigint[]`, which no amount of running it can notice.
#
# @electric-sql/pglite arrives here rather than further down because the parity pass now needs a
# real Postgres of its own: where the official validator crashes on a value there is nothing left
# to compare DRZL against, and a database is what settles whether DRZL's answer is right. The
# ground-truth stage in this same tree used to install it on its own line and now inherits it.
# No effect in this tree, and it is not an omission. This tree pins drizzle-orm 1.0.0-rc.4, whose
# own optional peer asks for effect >=4.0.0-beta.83, while @drzl/generator-effect targets the
# released 3.x. npm enforces an optional peer whenever the package is present, so the two cannot
# share a tree in either direction: a bare `effect` resolves to the 4 beta and fails against the
# generator, and `effect@^3` fails against drizzle-orm. Measured both ways.
#
# So effect is generated in the app tree above instead, which pins no drizzle major, and it takes
# no part in the parity pass here. That is the same shape as json-schema's exclusion and a stronger
# reason: there is an official drizzle-orm/effect, and it targets a major this generator does not.
#
# --legacy-peer-deps, because "no effect in this tree" must hold by construction, not by luck.
# The generator-effect tarball's optional peer (effect >=3.13.0) and drizzle rc.4's optional peer
# (>=4.0.0-beta.83) are disjoint under prerelease semver, and arborist sometimes materialises a
# node for an optional peer anyway; whether it does depends on its walk order, which any unrelated
# registry publish can reshuffle. That fired on 2026-08-08: this stage passed locally, then
# ERESOLVEd in CI minutes later with no change to the repo, and an effect 4.0.0-beta.106 publish
# the same morning kept it failing everywhere after. Every library this stage compares is an
# explicit root dependency on this line, so peer auto-install has nothing left to add and the
# flag only removes the walk-order sensitivity.
npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps \
  "$TARS"/*.tgz drizzle-orm@"$DRIZZLE_V1" zod valibot arktype @sinclair/typebox tsx typescript \
  ajv@^8.17.1 ajv-formats@^3.0.1 @seriousme/openapi-schema-validator@^2.9.1 \
  @electric-sql/pglite >/dev/null

for dialect in pg mysql sqlite; do
  case "$dialect" in
    # All four libraries on every dialect. It was four on Postgres and one everywhere else, so
    # valibot, arktype and typebox had never been compared with anything on MySQL or SQLite:
    # eighteen combinations with no differential coverage at all. The official modules take any
    # Drizzle table regardless of dialect, so there was never a structural reason for it. Widening
    # this also turns pass 2, the cross-generator check, on for MySQL and SQLite, which is where it
    # found the arktype json column disagreeing with its three siblings.
    pg)     schema=src/schema.ts;        libs="zod valibot arktype typebox" ;;
    mysql)  schema=src/schema-mysql.ts;  libs="zod valibot arktype typebox" ;;
    sqlite) schema=src/schema-sqlite.ts; libs="zod valibot arktype typebox" ;;
  esac
  gens=""
  for lib in $libs; do gens="$gens    { kind: '$lib', path: 'src/gen/$dialect/$lib' },"$'\n'; done
  # The sixth generator, on the one dialect with a real database behind it.
  #
  # It is deliberately not in `libs`: there is no official JSON Schema module for the parity pass
  # to compare it against, so it takes no part in that pass and is measured against Postgres
  # instead. Until this line existed it appeared in exactly one stage of this gate, the
  # documented-configs one, which asks only whether the emitted TypeScript compiles. The generator
  # that emits a published API contract was the only one whose output was never compared with a
  # database, with its siblings, or with a validator of any kind.
  #
  # `components: true` because the OpenAPI document is a second emission with its own rules, and
  # nothing outside the generator's own unit tests had ever produced one.
  if [ "$dialect" = pg ]; then
    gens="$gens    { kind: 'json-schema', path: 'src/gen/$dialect/json-schema', components: true, document: { format: 'both' } },"$'\n'
  fi
  cat > "drzl.$dialect.config.ts" <<CONFIG
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: '$schema',
  outDir: 'src/gen/$dialect',
  generators: [
$gens  ],
});
CONFIG
  npx drzl generate --config "drzl.$dialect.config.ts" >/dev/null
  # A second pass with `applyDefaults` on. The option had no coverage here at all, so a change
  # that stopped it working would have shipped with a green gate.
  if [ "$dialect" = pg ]; then
    cat > "drzl.$dialect.defaults.config.ts" <<CONFIG
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: '$schema',
  outDir: 'src/gen/${dialect}-defaults',
  generators: [{ kind: 'zod', path: 'src/gen/${dialect}-defaults/zod', applyDefaults: true }],
});
CONFIG
    npx drzl generate --config "drzl.$dialect.defaults.config.ts" >/dev/null
  fi
  for lib in $libs; do
    if [ ! -e "src/gen/$dialect/$lib/matrix.$lib.ts" ]; then
      echo "FAIL: the $lib generator produced no file for the $dialect parity matrix." >&2
      exit 1
    fi
  done
  # Named individually rather than derived, because this generator's file suffix and its extra
  # `components.ts` are not the `<table>.<lib>.ts` shape the loop above assumes, and a kind that
  # emitted nothing at all would otherwise be found only by an import failing much further down.
  if [ "$dialect" = pg ]; then
    # `openapi.ts` and `openapi.json` are named here for the same reason as `components.ts`: a
    # document that is simply not emitted has no shape for the loop above to miss, and the stage
    # below that validates it would then validate nothing and say so only by counting zero.
    for f in matrix.schema.ts nullable.schema.ts checked.schema.ts defaulted.schema.ts components.ts index.ts openapi.ts openapi.json; do
      if [ ! -e "src/gen/pg/json-schema/$f" ]; then
        echo "FAIL: the json-schema generator produced no src/gen/pg/json-schema/$f." >&2
        exit 1
      fi
    done
  fi
done
