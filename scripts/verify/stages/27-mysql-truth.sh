# MySQL is the one dialect with no in-process engine, so this stage runs only where a server is
# reachable: CI provides one as a service container, and a local run without `MYSQL_URL` skips it
# and says so rather than silently covering less than the output claims.
if [ -n "${MYSQL_URL:-}" ]; then
npm install --no-audit --no-fund --loglevel=error mysql2 >/dev/null

cp "$HARNESS/mysql-truth.ts" src/mysql-truth.ts

echo "==> ground truth: the emitted schemas against a real MySQL"
if ! npx tsx src/mysql-truth.ts | tee -a "$WORK/printed.log"; then
  echo "FAIL: a generated schema disagrees with MySQL." >&2
  exit 1
fi
else
  echo "==> MySQL ground truth skipped: no MYSQL_URL"
fi
