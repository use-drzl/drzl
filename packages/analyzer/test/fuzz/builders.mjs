/**
 * Every column a drizzle core can build, taken from the core's own exports.
 *
 * Nothing in this file names a column type. The list of builders is whatever the module exports
 * that answers to being called and hands back a ColumnBuilder, and the list of dialects is
 * whatever the package's `exports` map calls a `*-core`. That is the whole point: a fuzzer built
 * on a hand-written list of column types inherits exactly the blind spot it exists to find, and
 * every defect this repository fixed in the last week was a column somebody had not thought to
 * write down.
 *
 * What *is* written down here is the argument pool, because drizzle states option shapes only in
 * TypeScript and there is nothing to read at runtime. The guard against that list being short is
 * `unreachedColumnClasses`: every core also exports the column *classes* it can produce, so the
 * set of classes the pool actually reached can be subtracted from the set the module ships, and
 * the difference is reported as a coverage gap rather than passing silently. That guard is what
 * caught `mysqlEnum`, whose values are a positional argument and which no object-shaped option
 * would ever have reached.
 */

const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/** The two majors, and the specifier each is installed under in this package. */
export const MAJORS = [
  { id: '0.4x', pkg: 'drizzle-orm' },
  { id: 'v1', pkg: 'drizzle-orm-v1' },
];

/**
 * Where a package is installed.
 *
 * `require.resolve(pkg + '/package.json')` is the obvious way and drizzle forbids it: its
 * `exports` map does not list `./package.json`, so the resolver refuses. The entry point is
 * listed, so resolve that and walk up to the manifest beside it.
 */
export async function packageDir(pkg) {
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const fs = await import('node:fs');
  let dir = path.dirname(createRequire(import.meta.url).resolve(pkg));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`no package.json found for ${pkg}`);
}

/** The version actually installed under a specifier, which for an alias is not the specifier. */
export async function packageVersion(pkg) {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(`${await packageDir(pkg)}/package.json`, 'utf8'));
  return `${manifest.name}@${manifest.version}`;
}

/**
 * The dialect entry points a drizzle package ships, read from its `exports` map.
 *
 * `gel-core` exists only on 0.4x and `mssql-core`/`cockroach-core` only on v1, and neither fact is
 * stated here; the map says so. `effect-core` is in v1's map too and is dropped by `enumerateCore`,
 * which cannot even import it without the `effect` package installed.
 */
export async function coreSpecifiers(pkg) {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(`${await packageDir(pkg)}/package.json`, 'utf8'));
  return Object.keys(manifest.exports ?? {})
    .filter((k) => /^\.\/[a-z0-9]+-core$/.test(k))
    .map((k) => `${pkg}/${k.slice(2)}`)
    .sort();
}

/**
 * Call an export and hand back whatever it produced, or `undefined` if it refused.
 *
 * A core exports far more than column builders, and some of what it exports is an async function
 * that rejects when called with a column name: `migrate(['a','b','c'])` on v1's mysql-core returns
 * a promise that rejects reading `config.migrationsTable`. A rejection nothing awaits kills the
 * process, so a thenable result is settled and discarded here rather than left loose. The probe
 * that found this was the name-less enum spelling, which calls every export with one array.
 */
function probe(fn, args) {
  let out;
  try {
    out = fn(...args);
  } catch {
    return undefined;
  }
  if (out && typeof out.then === 'function') {
    Promise.resolve(out).then(
      () => {},
      () => {}
    );
    return undefined;
  }
  return out;
}

/** Whether a value is a built-but-unattached column builder. */
function isColumnBuilder(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.build === 'function' &&
    typeof v.notNull === 'function' &&
    !!v.config &&
    typeof v.config.dataType === 'string'
  );
}

function entityKindOf(v) {
  return String(v?.constructor?.[ENTITY_KIND] ?? v?.constructor?.name ?? '');
}

/**
 * Second arguments to try against every exported function.
 *
 * A flat pool rather than a cross product: the builders that take two options at once take a
 * fixed pair (`geometry` wants a type and a mode, sqlite's bigint blob wants a mode and a length),
 * and enumerating the full product of eight facets would build several million throwaway objects
 * to reach the same classes. Every entry that produces nothing new is dropped by the dedupe in
 * `enumerateCore`, so an entry costs nothing but a constructor call.
 *
 * The `mode` values are the ones the brief names plus the ones the cores turned out to have. A
 * value no builder reacts to leaves no trace, because dedupe is on what the built column *is*.
 *
 * The two array entries are not options at all. `mysqlEnum('m', ['a','b'])` takes its values
 * positionally and returns a column builder outright, where `pgEnum('m', ['a','b'])` returns a
 * factory; both shapes are here, and the coverage guard is what showed the first one was missing.
 */
const SECOND_ARGS = [
  undefined,
  {},
  // modes
  { mode: 'number' },
  { mode: 'bigint' },
  { mode: 'string' },
  { mode: 'date' },
  { mode: 'xy' },
  { mode: 'abc' },
  { mode: 'tuple' },
  { mode: 'timestamp' },
  { mode: 'timestamp_ms' },
  { mode: 'buffer' },
  { mode: 'json' },
  { mode: 'boolean' },
  { mode: 'text' },
  { mode: 'blob' },
  { mode: 'secret' },
  // widths
  { length: 1 },
  { length: 8 },
  { length: 255 },
  { length: 8, mode: 'number' },
  { length: 8, mode: 'bigint' },
  { length: 255, mode: 'string' },
  { length: 8, mode: 'buffer' },
  { length: 8, mode: 'json' },
  // fixed point
  { precision: 3 },
  { precision: 10, scale: 2 },
  { precision: 20, scale: 0 },
  { precision: 10, scale: 2, mode: 'number' },
  { precision: 20, scale: 0, mode: 'bigint' },
  { precision: 10, scale: 2, mode: 'string' },
  // vectors and bit strings. `elementType` is SingleStore's, and the coverage guard is what
  // asked for it: without the I64 entry, `SingleStoreBigIntVector` was a class no run reached.
  { dimensions: 3 },
  { dimensions: 16 },
  { dimensions: 3, elementType: 'I64' },
  { dimensions: 3, elementType: 'F32' },
  // inline enums, in both the object and the positional spelling
  { enum: ['a', 'b', 'c'] },
  { enum: ['a', 'b', 'c'], length: 8 },
  ['a', 'b', 'c'],
  // temporal
  { withTimezone: true },
  { withTimezone: true, precision: 3 },
  { withTimezone: true, mode: 'string' },
  { precision: 3, mode: 'string' },
  // integer widths spelled as an option rather than as a builder
  { unsigned: true },
  { unsigned: true, mode: 'bigint' },
  // geometry
  { type: 'point' },
  { type: 'point', mode: 'tuple' },
  { type: 'point', mode: 'xy' },
  { type: 'point', srid: 4326 },
];

/** Serialise a builder's own config, so two variants that produce the same column collapse. */
function configSignature(builder) {
  const cfg = builder.config ?? {};
  const out = {};
  for (const k of Object.keys(cfg).sort()) {
    if (k === 'name' || k === 'keyAsName') continue;
    const v = cfg[k];
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
    try {
      out[k] = JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)));
    } catch {
      out[k] = String(v);
    }
  }
  return JSON.stringify(out);
}

/**
 * A source-renderable literal.
 *
 * The fuzzer emits a real schema file and analyses that, rather than handing the analyzer an
 * object it built in memory, so every argument has to survive being written out and parsed back.
 */
export function literal(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Date) return `new Date(${v.getTime()})`;
  if (v instanceof Uint8Array) return `new Uint8Array([${Array.from(v).join(',')}])`;
  return JSON.stringify(v);
}

/**
 * One buildable column: what to import, what to call, and what the built column turned out to be.
 *
 * `preamble` carries the declarations a column needs beside it. An enum column is the case: a
 * `pgEnum` is a schema-level object the column refers to, so it has to be emitted as its own
 * statement rather than inlined into the column expression.
 */
function makeSpec({ core, exportName, preamble, callee, args, builder }) {
  const entityKind = entityKindOf(builder);
  return {
    core,
    exportName,
    preamble: preamble ?? null,
    callee,
    args,
    entityKind,
    /** The class the *column* will be, which is the builder's kind without the suffix. */
    columnKind: entityKind.replace(/Builder$/, ''),
    dataType: builder.config.dataType,
    /** `.array()` is a Postgres-family method; asking is cheaper than knowing which dialects have it. */
    canArray: typeof builder.array === 'function',
    /** How this variant reads in a report, and the key the two majors are matched on. */
    signature: `${exportName}(${args.map(literal).join(', ')})`,
    configSignature: configSignature(builder),
    /**
     * The call as source. The first argument is replaced by the column's name when it is a name;
     * a builder called with no name at all (`mysqlEnum(['a','b'])`) keeps its arguments and takes
     * the object key as its name, which is a shape the analyzer has its own tests for.
     */
    render(name) {
      const callArgs =
        typeof args[0] === 'string' ? [literal(name), ...args.slice(1).map(literal)] : args.map(literal);
      return `${callee}(${callArgs.join(', ')})`;
    },
  };
}

/**
 * Enumerate every column builder one core exports, in every argument variant that changes the
 * column it builds.
 *
 * Returns null when the module cannot be loaded at all, which is how `effect-core` drops out: it
 * imports the `effect` package, which is not installed.
 */
export async function enumerateCore(coreSpec) {
  let mod;
  try {
    mod = await import(coreSpec);
  } catch {
    return null;
  }
  const names = Object.keys(mod).sort();
  // The dialect's own name first, and the pattern only as a fallback. `*Table` alone picks the
  // first match in sorted order, and on every core except mssql that is `extractUsedTable`, a
  // drizzle internal rather than the table constructor. The generated module then built something
  // that was not a table at all, the analyzer reported `dialect: unknown` with zero tables, and
  // every builder in the run came back as one the analyzer had dropped. Roughly 1100 findings, all
  // of them this.
  const dialect = /\/([a-z0-9]+)-core$/.exec(coreSpec)?.[1];
  const preferred = dialect ? `${dialect}Table` : null;
  const tableFn =
    (preferred && typeof mod[preferred] === 'function' ? preferred : null) ??
    names.find((n) => /^[a-z][A-Za-z0-9]*Table$/.test(n) && typeof mod[n] === 'function');
  if (!tableFn) return null;

  const specs = [];
  const seen = new Set();
  // Monotonic, so two variants of one export never declare the same binding. See the enum sites.
  let bindingSeq = 0;
  const add = (s) => {
    const key = `${s.entityKind}|${s.configSignature}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(s);
  };

  for (const name of names) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    // Exported classes are functions too. Calling one without `new` throws, so they drop out of
    // the loop below on their own rather than being filtered by a name pattern.

    for (const second of SECOND_ARGS) {
      const args = second === undefined ? ['c'] : ['c', second];
      const built = probe(fn, args);
      if (built === undefined) continue;

      if (isColumnBuilder(built)) {
        add(makeSpec({ core: coreSpec, exportName: name, callee: name, args, builder: built }));
        continue;
      }

      // An enum factory hands back a *function* carrying the values, which is then called to get
      // the column: `pgEnum('m', [...])`. The factory is a schema-level object, so it is emitted
      // as its own statement and the column refers to the binding.
      if (typeof built === 'function' && Array.isArray(built.enumValues)) {
        const col = probe(built, ['c']);
        if (!isColumnBuilder(col)) continue;
        const binding = `__enum_${name}_${bindingSeq++}`;
        add(
          makeSpec({
            core: coreSpec,
            exportName: name,
            preamble: { binding, code: `const ${binding} = ${name}(${args.map(literal).join(', ')});` },
            callee: binding,
            args: ['c'],
            builder: col,
          })
        );
      }
    }

    // The name-less enum spelling, whose only argument is the values.
    const nameless = probe(fn, [['a', 'b', 'c']]);
    if (isColumnBuilder(nameless)) {
      add(
        makeSpec({
          core: coreSpec,
          exportName: name,
          callee: name,
          args: [['a', 'b', 'c']],
          builder: nameless,
        })
      );
    } else if (typeof nameless === 'function' && Array.isArray(nameless.enumValues)) {
      let col;
      try {
        col = nameless('c');
      } catch {
        col = undefined;
      }
      if (isColumnBuilder(col)) {
        const binding = `__enum0_${name}_${bindingSeq++}`;
        add(
          makeSpec({
            core: coreSpec,
            exportName: name,
            preamble: { binding, code: `const ${binding} = ${name}(${literal(['a', 'b', 'c'])});` },
            callee: binding,
            args: ['c'],
            builder: col,
          })
        );
      }
    }
  }

  // `customType` is a factory over a user-written codec, so no argument in the pool reaches it.
  // Its whole point is that the JS type exists only at compile time, which is the case the
  // analyzer has the least to go on and therefore the one most worth generating.
  if (typeof mod.customType === 'function') {
    for (const [tag, sqlType] of [
      ['text', 'text'],
      ['numeric', 'numeric(12,2)'],
      ['bytes', 'bytea'],
    ]) {
      let col;
      const binding = `__custom_${tag}_${bindingSeq++}`;
      try {
        col = mod.customType({ dataType: () => sqlType })('c');
      } catch {
        continue;
      }
      if (!isColumnBuilder(col)) continue;
      add(
        makeSpec({
          core: coreSpec,
          exportName: 'customType',
          preamble: {
            binding,
            code: `const ${binding} = customType({ dataType: () => ${literal(sqlType)} });`,
          },
          callee: binding,
          args: ['c'],
          builder: col,
        })
      );
    }
  }

  return { core: coreSpec, tableFn, specs };
}

/**
 * Column classes a core exports that the enumeration never produced.
 *
 * The completeness guard, and the reason this fuzzer is not just its own argument pool read back.
 * A run that reaches 40 of a core's 46 column classes has not covered that core, and without this
 * it would look exactly like a run that covered it: both report the same findings from the columns
 * they did reach. Derived from `instanceof Column` over the module's own exports, so a class added
 * by a future drizzle release shows up as a gap on the first run rather than staying invisible
 * until somebody thinks to write it down.
 *
 * Abstract bases are removed by asking the exports themselves: a class another exported column
 * class extends is never built directly.
 *
 * `reached` is passed in from the tables the fuzzer actually emitted, not just from the builder
 * list, because `.array()` wraps a column in a class of its own (`PgArray`, `CockroachArray`,
 * `GelArray`) that no builder produces.
 */
export async function unreachedColumnClasses(coreSpec, reached) {
  const mod = await import(coreSpec);
  const rootPkg = coreSpec.replace(/\/[a-z0-9]+-core$/, '');
  const { Column } = await import(rootPkg);

  const classes = Object.entries(mod).filter(
    ([, v]) => typeof v === 'function' && v.prototype && v.prototype instanceof Column
  );
  const bases = new Set();
  for (const [, v] of classes) {
    for (const [, other] of classes) {
      if (v !== other && other.prototype instanceof v) bases.add(v);
    }
  }
  return [...new Set(classes.filter(([, v]) => !bases.has(v)).map(([n, v]) => String(v[ENTITY_KIND] ?? n)))]
    .filter((k) => !reached.has(k))
    // `ExtraConfigColumn` is the wrapper drizzle hands to a table's third argument, not a column
    // of the table: `drizzle:Columns` never holds one, and the analyzer reads only that. Waived
    // rather than counted, and the claim is asserted in fuzz-analyzer.spec.ts rather than trusted.
    .filter((k) => !/ExtraConfigColumn$/.test(k))
    .sort();
}
