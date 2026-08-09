#!/usr/bin/env bash
#
# One documented config: write it out as a real project, generate from it, and typecheck what came
# out. Invoked once per config by the documented-configs stage, four at a time under xargs.
#
# A file of its own rather than a shell function, because xargs runs a command and the four copies
# have to be able to fail independently. The verdict goes to $DOC_OUT/<i>.out rather than to
# stdout, and a failure additionally touches $DOC_OUT/<i>.failed: four workers writing to one
# stream would interleave their lines, and the stage prints the files in index order afterwards so
# the run says the same thing in the same order whatever order they finish in.
#
# Runs in the consumer tree ($APP), inherited from the stage, so `npx drzl` resolves the packed
# CLI out of that tree's node_modules exactly as it did when this was one loop in one directory.
#
# Reads DOC_OUT, FIXTURES and HARNESS from the environment; the stage exports them.
set -euo pipefail

i="$1"
probe="docs-probe/$i"
out="$DOC_OUT/$i.out"

label="$(node -e "const c=require('/tmp/doc-configs.json')[$i]; process.stdout.write(c.file+':'+c.line)")"
schema="$(node -e "process.stdout.write(require('/tmp/doc-configs.json')[$i].schema)")"
outdir="$(node -e "process.stdout.write(require('/tmp/doc-configs.json')[$i].outDir)")"

rm -rf "$probe" && mkdir -p "$probe/$(dirname "$schema")" "$probe/src/db"
# A schema exercising the cases these configs care about: a generated key, a natural key, a
# nullable column and a foreign key.
cp "$FIXTURES/docs-probe.schema.ts" "$probe/$schema"
# Some configs point `dbImportPath` at a connection module. That is the reader's own file, so
# the fixture supplies one rather than the config being wrong for naming it.
echo 'export const db = {} as any;' > "$probe/src/db/connection.ts"

node "$HARNESS/write-doc-config.cjs" "$i" "$probe/drzl.config.ts"
# A custom template the docs reference by path would not exist here; that is a documentation
# example about authoring one, not a config to run.
if grep -qE "template:\s*'\./" "$probe/drzl.config.ts"; then
  echo "    $label  skipped (references a local template file)" > "$out"
  exit 0
fi

if ! (cd "$probe" && npx drzl generate >/dev/null 2>&1); then
  echo "    $label  GENERATE FAILED" > "$out"
  : > "$DOC_OUT/$i.failed"
  exit 0
fi

cat > "$probe/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
EOF
# The tsc log lives in the probe directory rather than at one path in /tmp, which is what it used
# to be: four workers sharing that path would each print another config's errors.
if (cd "$probe" && npx tsc -p tsconfig.json > tsc.log 2>&1); then
  echo "    $label  ok" > "$out"
else
  # `head` first and `sed` second, which prints the same five indented lines the other order did.
  # Indenting the whole log into a `head` that closes the pipe after five lines is a SIGPIPE this
  # shell reads through `pipefail`, so a config with a long enough error list could kill the worker
  # instead of reporting the config.
  {
    echo "    $label  DOES NOT TYPECHECK"
    head -5 "$probe/tsc.log" | sed 's/^/        /'
  } > "$out"
  : > "$DOC_OUT/$i.failed"
fi
exit 0
