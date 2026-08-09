import { readFileSync } from 'node:fs';
import { SchemaAnalyzer } from '@drzl/analyzer';

// Everything the analyzer says about these schema files, and the drizzle-orm that produced it.
//
// The whole column object rather than a chosen list of fields. A list is a decision, taken in
// advance, about which facts are allowed to differ, and it is silently wrong the moment the
// analyzer learns a new one: `integer`, `maxBytes`, `defaultValue`, `hasDefault`, `isGenerated`
// and `references` are all fields the list this replaced did not have, and it flattened `shape`
// to its `kind`, which drops a tuple's length and a bit string's exactness. `integer` alone
// carries five of the differences reported below.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
  // Off disk rather than through `require.resolve`: drizzle-orm's `exports` map has no
  // `./package.json` entry, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED. Reading it is
  // also the point of this line, which is to report the version of the tree this ran in rather
  // than the version somebody believes it installed.
  const pkg = JSON.parse(readFileSync('node_modules/drizzle-orm/package.json', 'utf8'));
  const out: {
    drizzle: string;
    tables: Record<string, unknown>;
    columns: Record<string, unknown>;
    fields: { table: string[]; column: string[] };
  } = { drizzle: pkg.version, tables: {}, columns: {}, fields: { table: [], column: [] } };
  // The field names the analyzer produced, collected before this is serialised. A field it sets
  // to `undefined` on every column, as it does with `references` until something references
  // something, is gone by the time the JSON is read, and a comparison cannot notice a field it
  // cannot see. This is what lets the guard downstream tell "always empty" from "not a field".
  const table = new Set<string>();
  const column = new Set<string>();
  for (const file of process.argv.slice(2)) {
    const a = await new SchemaAnalyzer(file).analyze({});
    // A fixture this drizzle cannot import analyzes to zero tables and one issue, and would
    // otherwise leave nothing behind but a smaller number in the count. Not hypothetical: the
    // MySQL parity fixture cannot be imported under 0.45.2 at all, because 0.4x's mysql-core
    // has no `blob` export.
    const failed = a.issues.filter((i) => i.code === 'DRZL_ANL_IMPORT');
    if (failed.length) {
      console.error(`FAIL: ${file} could not be imported under drizzle-orm ${pkg.version}:`);
      for (const i of failed) console.error(`      ${i.message}`);
      process.exit(1);
    }
    for (const t of a.tables) {
      // Two fixture files exporting a table of the same name would silently keep one table's
      // facts and both tables' columns under the same prefix, comparing a mixture of the two.
      if (out.tables[t.name]) {
        console.error(`FAIL: two schema files both export a table called ${t.name}, so this`);
        console.error('      description would mix them. Rename one.');
        process.exit(1);
      }
      const { columns, ...rest } = t;
      out.tables[t.name] = rest;
      for (const k of Object.keys(rest)) table.add(k);
      for (const c of columns) {
        out.columns[`${t.name}.${c.name}`] = c;
        for (const k of Object.keys(c)) column.add(k);
      }
    }
  }
  out.fields = { table: [...table].sort(), column: [...column].sort() };
  console.log(JSON.stringify(out, null, 1));
}
