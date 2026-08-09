# ---------------------------------------------------------------------------------------------
# Every dialect, not just SQLite.
#
# The analyzer claims sqlite, postgres, mysql, singlestore and gel, and this guard exercised one
# of them. Each dialect stores its foreign keys under a differently named symbol and has its own
# column classes, so a change that works for SQLite can silently produce nothing for Postgres.
# ---------------------------------------------------------------------------------------------
echo "==> generating from every dialect"
for dialect in pg mysql; do
  mkdir -p "src/dia-$dialect"
  case "$dialect" in
    pg)
      cp "$FIXTURES/dialect-pg.schema.ts" "src/dia-$dialect/schema.ts"
      # A typed, driverless db object. The docs-probe stage's `{} as any` collapses every builder
      # call, which is how the BN (.returning() on MySQL) and BP (id: number on a varchar key)
      # classes stayed invisible; a real PgDatabase type makes tsc see the builders.
      cp "$FIXTURES/dialect-pg.db.ts" "src/dia-$dialect/db.ts"
      ;;
    mysql)
      cp "$FIXTURES/dialect-mysql.schema.ts" "src/dia-$dialect/schema.ts"
      cp "$FIXTURES/dialect-mysql.db.ts" "src/dia-$dialect/db.ts"
      ;;
  esac

  cat > drzl.config.ts <<CONFIG
export default {
  schema: './src/dia-$dialect/schema.ts',
  outDir: './src/dia-$dialect/api',
  generators: [
    { kind: 'zod', path: './src/dia-$dialect/zod' },
    { kind: 'orpc', includeRelations: true },
    { kind: 'service', path: './src/dia-$dialect/services', dataAccess: 'drizzle', dbImportPath: 'src/dia-$dialect/db', schemaImportPath: 'src/dia-$dialect/schema' },
  ],
};
CONFIG
  npx drzl generate >/dev/null

  # A natural primary key must survive into the insert schema, and a foreign key must produce a
  # lookup. Both were broken for every dialect at some point without this guard noticing.
  grep -q 'isbn' "src/dia-$dialect/zod/books.zod.ts" || {
    echo "FAIL [$dialect]: the natural primary key 'isbn' is missing from the emitted schemas." >&2
    exit 1
  }
  grep -q 'listByAuthorId' "src/dia-$dialect/api/books.ts" || {
    echo "FAIL [$dialect]: no relation lookup emitted for the authorId foreign key." >&2
    exit 1
  }
  # The tRPC addressing input, against the same natural key. A generator that hardcodes
  # `{ id: number }` passes every typecheck in this gate and fails the moment a table is keyed on
  # anything else, so the column name has to appear in the router that addresses by it.
  if [ -f "src/dia-$dialect/trpc/books.ts" ]; then
    grep -q 'isbn' "src/dia-$dialect/trpc/books.ts" || {
      echo "FAIL [$dialect]: the tRPC books router does not address by the real key 'isbn'." >&2
      exit 1
    }
  fi
  # The drizzle-mode service against the typed db, keyed by the varchar it is. The tsc below is
  # what actually catches the BN and BP classes; this grep names the defect when the emission
  # regresses to id: number without breaking compilation some other way.
  grep -q 'id: string' "src/dia-$dialect/services/bookService.ts" || {
    echo "FAIL [$dialect]: the books service does not type its key as the varchar it is." >&2
    exit 1
  }

  cat > "tsconfig.$dialect.json" <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["src/dia-$dialect/**/*.ts"]
}
EOF
  if ! npx tsc -p "tsconfig.$dialect.json"; then
    echo "FAIL [$dialect]: emitted output does not typecheck." >&2
    exit 1
  fi
  echo "    $dialect ok"
done
