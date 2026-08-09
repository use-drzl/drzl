import fs from 'node:fs';
const CARVED = { pg: ['c_numeric', 'c_decimal'], mysql: ['m_decimal'] };
const MODES = 3;
const excludes = [];
let probes = 0;
for (const [dialect, cols] of Object.entries(CARVED)) {
  const from = `src/gen/${dialect}/arktype/matrix.arktype.ts`;
  const lines = fs.readFileSync(from, 'utf8').split('\n');
  const drop = new RegExp(`^\\s*"(${cols.join('|')})\\??":`);
  const kept = lines.filter((l) => !drop.test(l));
  const removed = lines.length - kept.length;
  if (removed !== cols.length * MODES) {
    console.error(
      `FAIL: carving ${cols.join(', ')} out of ${from} removed ${removed} lines, not ` +
        `${cols.length * MODES}. The emitted shape changed, so this exclusion no longer covers ` +
        `what it says it covers and may now be hiding a real error.`
    );
    process.exit(1);
  }
  fs.writeFileSync(`src/gen-tsc/${dialect}-matrix.arktype.ts`, kept.join('\n'));
  // One probe per carved column: the compiled copy with that column, and only that column, put
  // back. Somewhere outside the include below, so the stage's own run does not compile them.
  for (const col of cols) {
    const one = new RegExp(`^\\s*"${col}\\??":`);
    const withCol = lines.filter((l) => !drop.test(l) || one.test(l));
    if (withCol.length !== kept.length + MODES) {
      console.error(`FAIL: restoring ${col} into the ${dialect} copy did not put back ${MODES} lines.`);
      process.exit(1);
    }
    fs.writeFileSync(`src/carve-probe/${dialect}-${col}.ts`, withCol.join('\n'));
    probes++;
  }
  // The exclusions come from the same map as the copies, rather than being written out beside it.
  // Hardcoding them meant the two could disagree, and in exactly one direction: emptying CARVED
  // wrote no stand-in copies while the exclude list went on hiding both original modules, so 40
  // Postgres and 29 MySQL columns were dropped from the typecheck entirely and the stage still
  // said everything compiled. Derived, an empty CARVED excludes nothing and the originals are
  // compiled directly, which fails loudly if the defect is still there.
  excludes.push(
    `src/gen/${dialect}/arktype/matrix.arktype.ts`,
    // The barrel with it: `exclude` only filters the entry list, so an `index.ts` re-exporting the
    // matrix module would pull the original straight back in.
    `src/gen/${dialect}/arktype/index.ts`
  );
}
fs.writeFileSync('carve-manifest.txt', String(probes));
fs.writeFileSync(
  'tsconfig.gen.json',
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        skipLibCheck: true,
      },
      include: [
        'src/gen/**/*.ts',
        'src/gen-tsc/**/*.ts',
        'src/schema.ts',
        'src/schema-mysql.ts',
        'src/schema-sqlite.ts',
      ],
      exclude: excludes,
    },
    null,
    2
  )
);
